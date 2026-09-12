import { GuildTextBasedChannel, Message } from "discord.js";
import { Sequelize } from "sequelize";

/**
 * Pure, dependency-injected helpers for the incremental catchup path
 * (initialBackupServices). Models/fetchers are passed in so this module stays
 * testable without importing the client-side index (which instantiates the
 * Discord Client at load) — same convention as cacheServices.
 *
 * NOTE: this module grows per SDD task (T1 → cursor map, T2 → IGNORE filter,
 * T3 → forward paging, T4 → unit guards). See sdd/initial-backup-incremental-catchup.
 */

export type ChannelUnit = {
    channel: GuildTextBasedChannel;
    cursor?: Message;
    after?: string;
    direction?: 'forward' | 'backward';
};

export const cursor_map_from_rows = (rows: Array<{channelId: string; maxId: unknown}>): Map<string, string> => {
    const map = new Map<string, string>();
    for(const row of rows){
        if(row.maxId === null || row.maxId === undefined) continue;
        map.set(row.channelId, String(row.maxId));
    }
    return map;
};

/**
 * Cursor source of truth (R1): per-channel numeric MAX of messageId.
 * The outer CAST AS TEXT keeps the exact decimal string — the sqlite3 driver
 * returns INTEGER as an imprecise JS number for 19-digit snowflakes (> 2^53),
 * which would corrupt the after: cursor.
 */
export const build_cursor_map = async (messages_model: any): Promise<Map<string, string>> => {
    const rows = await messages_model.findAll({
        attributes: [
            'channelId',
            [Sequelize.cast(Sequelize.fn('MAX', Sequelize.cast(Sequelize.col('messageId'), 'INTEGER')), 'TEXT'), 'maxId']
        ],
        group: ['channelId'],
        raw: true
    });
    return cursor_map_from_rows(rows);
};

export const is_ignored = (channelId: string, ignoreChannels: string[]): boolean => ignoreChannels.includes(channelId);

export const filter_ignored_channels = <T extends {id: string}>(channels: T[], ignoreChannels: string[]): T[] =>
    channels.filter(c => !is_ignored(c.id, ignoreChannels));

/**
 * Which complete rows become forward incremental units (R1 + R4):
 * status complete, channel not ignored, and a messages-derived cursor exists.
 */
export const incremental_candidates = (
    checkpoints: Array<{channelId: string; status: string}>,
    cursorMap: Map<string, string>,
    ignoreChannels: string[]
): Array<{channelId: string; after: string}> => {
    const out: Array<{channelId: string; after: string}> = [];
    for(const row of checkpoints){
        if(row.status !== 'complete') continue;
        if(ignoreChannels.includes(row.channelId)) continue;
        const after = cursorMap.get(row.channelId);
        if(after === undefined) continue;
        out.push({channelId: row.channelId, after});
    }
    return out;
};

export const is_forward_unit = (unit: {direction?: 'forward' | 'backward'}): boolean => unit.direction === 'forward';

/**
 * Guards for initial_backup_process: forward (incremental) units must never
 * write in_progress and must never count channels_done (R2/R3) — the checkpoint
 * stays complete so the messages table remains the sole resume state. A crash
 * re-derives the cursor from MAX(messageId) and resumes forward idempotently.
 */
export const unit_guards = (unit: {direction?: 'forward' | 'backward'}) => {
    const forward = is_forward_unit(unit);
    return { writeInProgress: !forward, countDone: !forward };
};

/**
 * Forward paging loop (R1): fetch ascending via after:, advancing the window to
 * the NEWEST id of each page (discord.js returns newest-first), stopping when a
 * page has fewer than 100 messages. An empty delta costs exactly one fetch.
 */
export const crawl_forward = async <T extends {id: string}>(
    fetch_page: (after: string) => Promise<T[]>,
    initial_after: string,
    on_page: (page: T[], next_after: string) => Promise<void>,
    on_message: (msg: T) => Promise<void>
): Promise<{fetches: number; last_after: string}> => {
    let after = initial_after;
    let fetches = 0;
    let page: T[];
    do{
        page = await fetch_page(after);
        fetches++;
        if(page.length === 0) break;
        const next_after = page[0].id; //newest-first ordering → ascending window
        await on_page(page, next_after);
        for(const msg of page) await on_message(msg);
        after = next_after;
    }while(page.length === 100);
    return {fetches, last_after: after};
};