/**
 * Offline JSON exporter (Slice B, D5–D8).
 *
 * Reads server.db directly with its OWN Sequelize connection and inline model
 * definitions — never imports src/index.ts (which instantiates the Discord
 * Client at load) and never calls sequelize.sync() (strictly read-only:
 * missing tables are treated as empty caches, never created).
 *
 * Pipeline: load records -> decrypt raw BLOB bytes -> pure aggregation
 * (filters, sort, dedupe, sessions, threads-as-topics, watermark) -> write
 * export/messages.json + export/watermark.json.
 *
 * The pure functions (decryptText, resolveName, buildExport, readWatermark)
 * are exported so the fork's verify scripts can test them without a test
 * framework; main() only runs when this file is the process entry point.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import sqlite3 from "sqlite3";
import { BLOB, INTEGER, Sequelize, STRING } from "sequelize";
import { config as dotenvConfig } from "dotenv";

dotenvConfig(); // loads server-backup/.env for GUILD_ID (offline, cwd-relative)

// ---------- types ----------

export interface UserRecord {
    userId: string;
    username: string | null;
    displayName: string | null;
    globalName: string | null;
}

export interface ChannelRecord {
    channelId: string;
    name: string | null;
    type: string | null;
    parentId: string | null;
}

export interface MessageRecord {
    channelId: string;
    userId: string;
    messageId: string;
    time: number;
    text: Buffer | null;
}

export interface DecryptedMessageRecord extends Omit<MessageRecord, "text"> {
    text: string;
}

export interface ExportInput {
    messages: DecryptedMessageRecord[];
    users: UserRecord[];
    channels: ChannelRecord[];
}

export interface ExportOptions {
    guildId: string | null;
    password?: string;
    channelIds: string[];
    from: string | null;
    to: string | null;
    sessionGapMinutes: number;
    incremental: boolean;
    watermark: number | null;
}

export interface ParsedArgs {
    password?: string;
    guildId?: string;
    channelIds: string[];
    from: string | null;
    to: string | null;
    sessionGapMinutes: number;
    incremental: boolean;
    outDir: string;
}

export interface OutputEntry {
    id: string;
    channelId: string;
    authorId: string;
    author: string;
    channel: string;
    time: string;
    text: string;
}

export interface Topic {
    id: string;
    name: string;
    channelId: string;
    timeline: OutputEntry[];
}

export interface Session {
    start: string;
    end: string;
    channelIds: string[];
    timeline: OutputEntry[];
    topics: Topic[];
}

export interface ExportOutput {
    schemaVersion: string;
    guildId: string | null;
    generatedAt: string;
    mode: "full" | "incremental";
    filter: { channelIds: string[]; from: string | null; to: string | null };
    users: Record<string, { username: string | null; displayName: string | null; globalName: string | null }>;
    channels: Record<string, { name: string | null; type: string | null; parentId: string | null }>;
    sessions: Session[];
}

export interface ExportResult {
    output: ExportOutput;
    maxTime: number | null;
    emittedCount: number;
}

// ---------- decryption (D6, security spec: raw BLOB bytes, no hex decode) ----------

/**
 * Decrypt a message BLOB with the backup cipher (aes256, zero IV,
 * scryptSync(password, 'salt', 32)) and return the UTF-8 text.
 *
 * - No password -> passthrough: the DB was written unencrypted (empty key),
 *   so the stored bytes ARE the UTF-8 text.
 * - Wrong/missing key -> clear error: decipher.final() throws on the CBC
 *   padding check (ERR_OSSL_EVP_BAD_DECRYPT), and the fatal TextDecoder
 *   catches ciphertext that happens to survive as invalid UTF-8. Ciphertext
 *   is NEVER silently emitted as message text.
 */
let keyDerivationCount = 0;
const keyCache = new Map<string, Buffer>();

const deriveKey = (password: string): Buffer => {
    keyDerivationCount++;
    return crypto.scryptSync(password, "salt", 32);
};

const getKey = (password: string): Buffer => {
    let key = keyCache.get(password);
    if (key == null) {
        key = deriveKey(password);
        keyCache.set(password, key);
    }
    return key;
};

/** Test hook: number of scrypt derivations performed in this process. */
export const getKeyDerivationCount = (): number => keyDerivationCount;

export const decryptText = (blob: Buffer | null | undefined, password?: string): string => {
    if (blob == null || blob.length === 0) return "";

    let bytes: Buffer;
    if (password) {
        const key = getKey(password);
        const decipher = crypto.createDecipheriv("aes256", key, Buffer.alloc(16, 0));
        try {
            // raw BLOB bytes directly — decryptDb.js's Buffer.from(text,'hex')
            // hex decode is a known bug and MUST NOT be replicated (D6)
            bytes = Buffer.concat([decipher.update(blob), decipher.final()]);
        } catch (err: any) {
            throw new Error(
                `decryption failed: wrong or missing password (${err.code ?? err.message})`
            );
        }
    } else {
        bytes = blob;
    }

    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error(
            "decryption failed: output is not valid UTF-8 — the database appears encrypted and --password/PASSWORD is required"
        );
    }
};

// ---------- name resolution (spec: unknown (<id>) fallback, never crash) ----------

export const resolveName = (id: string, names: Map<string, string>): string =>
    names.get(id) ?? `unknown (${id})`;

const buildNameMap = (
    users: UserRecord[],
    channels: ChannelRecord[]
): { userNames: Map<string, string>; channelNames: Map<string, string>; threadIds: Set<string> } => {
    const userNames = new Map<string, string>();
    for (const u of users) {
        const name = u.displayName ?? u.username ?? u.globalName;
        if (name) userNames.set(u.userId, name);
    }
    const channelNames = new Map<string, string>();
    const threadIds = new Set<string>();
    for (const c of channels) {
        if (c.name) channelNames.set(c.channelId, c.name);
        if (c.type === "thread") threadIds.add(c.channelId);
    }
    return { userNames, channelNames, threadIds };
};

// ---------- pure aggregation (B1.4–B1.7) ----------

const parseIso = (value: string, flag: string): number => {
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) {
        throw new Error(`invalid ${flag} date: '${value}' (use ISO-8601, e.g. 2024-01-01T00:00:00.000Z)`);
    }
    return ms;
};

interface InternalEntry {
    id: string;
    channelId: string;
    authorId: string;
    author: string;
    channel: string;
    time: number;
    text: string;
}

interface InternalTopic {
    id: string;
    name: string;
    channelId: string;
    firstMs: number;
    lastMs: number;
    entries: InternalEntry[];
}

interface InternalSession {
    startMs: number;
    endMs: number;
    channelIds: string[];
    entries: InternalEntry[];
    topics: InternalTopic[];
}

const toOutputEntry = (e: InternalEntry): OutputEntry => ({
    id: e.id,
    channelId: e.channelId,
    authorId: e.authorId,
    author: e.author,
    channel: e.channel,
    time: new Date(e.time).toISOString(), // ISO-8601 UTC — never SQL strftime
    text: e.text,
});

export const buildExport = (input: ExportInput, options: ExportOptions): ExportResult => {
    const { userNames, channelNames, threadIds } = buildNameMap(input.users, input.channels);

    const channelFilter = new Set(options.channelIds);
    const fromMs = options.from != null ? parseIso(options.from, "--from") : null;
    const toMs = options.to != null ? parseIso(options.to, "--to") : null;

    // filter + empty-text skip + name resolution (B1.4, B1.5)
    const entries: InternalEntry[] = [];
    for (const m of input.messages) {
        if (m.text.trim().length === 0) continue; // empty/whitespace-only skipped
        if (channelFilter.size > 0 && !channelFilter.has(m.channelId)) continue;
        if (fromMs != null && m.time < fromMs) continue;
        if (toMs != null && m.time > toMs) continue;
        // incremental delta: strict > watermark (D7). Never applies in full mode.
        if (options.incremental && options.watermark != null && !(m.time > options.watermark)) continue;

        entries.push({
            id: m.messageId,
            channelId: m.channelId,
            authorId: m.userId,
            author: resolveName(m.userId, userNames),
            channel: resolveName(m.channelId, channelNames),
            time: m.time,
            text: m.text,
        });
    }

    // chronological order (time, messageId) + dedupe by messageId (B1.5)
    entries.sort(
        (a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const seen = new Set<string>();
    const unique: InternalEntry[] = [];
    for (const e of entries) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        unique.push(e);
    }

    // threads never inline (D8): separate by cached channel type
    const timeline: InternalEntry[] = [];
    const threadEntries: InternalEntry[] = [];
    for (const e of unique) {
        (threadIds.has(e.channelId) ? threadEntries : timeline).push(e);
    }

    // group threads by channelId -> topics, ordered by first-message time
    const topicMap = new Map<string, InternalEntry[]>();
    for (const e of threadEntries) {
        const group = topicMap.get(e.channelId);
        if (group) group.push(e);
        else topicMap.set(e.channelId, [e]);
    }
    const topics: InternalTopic[] = [];
    for (const [channelId, msgs] of topicMap) {
        topics.push({
            id: channelId,
            name: resolveName(channelId, channelNames),
            channelId,
            firstMs: msgs[0].time,
            lastMs: msgs[msgs.length - 1].time,
            entries: msgs,
        });
    }
    topics.sort((a, b) => a.firstMs - b.firstMs);

    // session grouping (D8): split at gaps > sessionGapMinutes*60000;
    // --from/--to forces a single session
    const gapMs = options.sessionGapMinutes * 60000;
    const singleSession = options.from != null || options.to != null;

    const sessions: InternalSession[] = [];
    if (timeline.length > 0) {
        let current: InternalSession = {
            startMs: timeline[0].time,
            endMs: timeline[0].time,
            channelIds: [timeline[0].channelId],
            entries: [timeline[0]],
            topics: [],
        };
        sessions.push(current);
        for (const e of timeline.slice(1)) {
            if (!singleSession && e.time - current.endMs > gapMs) {
                current = {
                    startMs: e.time,
                    endMs: e.time,
                    channelIds: [e.channelId],
                    entries: [e],
                    topics: [],
                };
                sessions.push(current);
            } else {
                current.entries.push(e);
                current.endMs = e.time;
                if (!current.channelIds.includes(e.channelId)) current.channelIds.push(e.channelId);
            }
        }
    } else if (topics.length > 0) {
        // threads-only DB: one synthetic session spanning the topics
        const first = Math.min(...topics.map((t) => t.firstMs));
        const last = Math.max(...topics.map((t) => t.lastMs));
        sessions.push({ startMs: first, endMs: last, channelIds: [], entries: [], topics: [] });
    }

    // attach each topic to the session whose window contains its first-message
    // time; when it falls in a gap, attach to the nearest-preceding session
    for (const t of topics) {
        let target = sessions[0];
        if (target) {
            for (const s of sessions) {
                if (s.startMs <= t.firstMs) target = s;
                else break;
            }
        }
        if (target) target.topics.push(t);
    }

    const outputSessions: Session[] = sessions.map((s) => ({
        start: new Date(s.startMs).toISOString(),
        end: new Date(s.endMs).toISOString(),
        channelIds: s.channelIds.sort(),
        timeline: s.entries.map(toOutputEntry),
        topics: s.topics.map((t) => ({
            id: t.id,
            name: t.name,
            channelId: t.channelId,
            timeline: t.entries.map(toOutputEntry),
        })),
    }));

    // watermark = max emitted time (across timeline + topics); null when empty
    let maxTime: number | null = null;
    for (const e of unique) {
        if (maxTime == null || e.time > maxTime) maxTime = e.time;
    }

    const output: ExportOutput = {
        schemaVersion: "1",
        guildId: options.guildId,
        generatedAt: new Date().toISOString(),
        mode: options.incremental ? "incremental" : "full",
        filter: {
            channelIds: [...options.channelIds],
            from: options.from,
            to: options.to,
        },
        users: Object.fromEntries(
            input.users.map((u) => [
                u.userId,
                { username: u.username, displayName: u.displayName, globalName: u.globalName },
            ])
        ),
        channels: Object.fromEntries(
            input.channels.map((c) => [
                c.channelId,
                { name: c.name, type: c.type, parentId: c.parentId },
            ])
        ),
        sessions: outputSessions,
    };

    return { output, maxTime, emittedCount: unique.length };
};

// ---------- atomic file writes (R4-2) ----------

const writeFileAtomic = (targetPath: string, data: string): void => {
    const dir = path.dirname(targetPath);
    const tmp = path.join(dir, `.tmp-${path.basename(targetPath)}-${process.pid}-${Date.now()}`);
    const fd = fs.openSync(tmp, "w");
    try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, targetPath);
};

// ---------- watermark sidecar (B1.6, D7) ----------

export const readWatermark = (outDir: string): number | null => {
    const file = path.join(outDir, "watermark.json");
    if (!fs.existsSync(file)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { maxTime?: number | null };
        return typeof parsed.maxTime === "number" ? parsed.maxTime : null;
    } catch {
        return null; // corrupt sidecar -> start fresh rather than crash
    }
};

// ---------- offline DB read (B1.1, D5) ----------

const defineExportModels = (sequelize: Sequelize) => {
    const messages = sequelize.define("messages", {
        channelId: { type: STRING },
        userId: { type: STRING },
        messageId: { type: STRING },
        time: { type: INTEGER },
        text: { type: BLOB },
    }, { timestamps: false, freezeTableName: true });
    const users = sequelize.define("users", {
        userId: { type: STRING, primaryKey: true },
        username: { type: STRING },
        displayName: { type: STRING },
        globalName: { type: STRING },
    }, { timestamps: false, freezeTableName: true });
    const channels = sequelize.define("channels", {
        channelId: { type: STRING, primaryKey: true },
        name: { type: STRING },
        type: { type: STRING },
        parentId: { type: STRING },
    }, { timestamps: false, freezeTableName: true });
    return { messages, users, channels };
};

// no sequelize.sync(): a missing table means "empty cache", never "create it"
const safeFindAll = async (model: any): Promise<any[]> => {
    try {
        return await model.findAll({ raw: true });
    } catch (err: any) {
        if (err?.original?.code === "SQLITE_ERROR" || /no such table/.test(String(err?.message ?? ""))) {
            return [];
        }
        throw err;
    }
};

const loadRecords = async (sequelize: Sequelize) => {
    const models = defineExportModels(sequelize);
    const [messages, users, channels] = await Promise.all([
        safeFindAll(models.messages),
        safeFindAll(models.users),
        safeFindAll(models.channels),
    ]);
    return {
        messages: messages.map((m: any) => ({
            channelId: m.channelId as string,
            userId: m.userId as string,
            messageId: m.messageId as string,
            time: m.time as number,
            text: m.text as Buffer | null,
        })),
        users: users.map((u: any) => ({
            userId: u.userId as string,
            username: u.username as string | null,
            displayName: u.displayName as string | null,
            globalName: u.globalName as string | null,
        })),
        channels: channels.map((c: any) => ({
            channelId: c.channelId as string,
            name: c.name as string | null,
            type: c.type as string | null,
            parentId: c.parentId as string | null,
        })),
    };
};

// ---------- orchestration (B1.2 entry: dist/export/exportMessages.js) ----------

export const runExport = async (
    sequelize: Sequelize,
    options: ExportOptions,
    outDir: string
): Promise<ExportResult> => {
    if (options.incremental && (options.channelIds.length > 0 || options.from != null || options.to != null)) {
        throw new Error(
            "--incremental cannot be combined with --channels, --from, or --to. " +
            "A filtered export would write a watermark based on a subset of messages, " +
            "causing a later unfiltered --incremental to skip never-exported messages."
        );
    }

    const { messages, users, channels } = await loadRecords(sequelize);

    // decrypt first — a single wrong/missing key aborts the whole export and
    // writes NOTHING (security spec: no ciphertext emitted as text)
    const errors: string[] = [];
    const decrypted: DecryptedMessageRecord[] = [];
    for (const m of messages) {
        try {
            decrypted.push({ ...m, text: decryptText(m.text, options.password) });
        } catch (err: any) {
            errors.push(`message ${m.messageId}: ${err.message}`);
        }
    }
    if (errors.length > 0) {
        throw new Error(
            `decryption failed for ${errors.length} message(s) — fix the password and re-run:\n${errors.slice(0, 5).join("\n")}`
        );
    }

    const result = buildExport({ messages: decrypted, users, channels }, options);

    // defensive guard: a filtered or otherwise regressed export must never
    // lower the watermark and silently hide messages from future runs.
    // Check before writing any output so a regression leaves files untouched.
    const existingWatermark = readWatermark(outDir);
    if (result.maxTime != null && existingWatermark != null && result.maxTime < existingWatermark) {
        throw new Error(
            `watermark regression rejected: new maxTime (${result.maxTime}) is lower ` +
            `than the existing watermark (${existingWatermark})`
        );
    }

    fs.mkdirSync(outDir, { recursive: true });
    const messagesPath = path.join(outDir, "messages.json");
    const watermarkPath = path.join(outDir, "watermark.json");
    writeFileAtomic(messagesPath, JSON.stringify(result.output, null, 2) + "\n");
    if (result.maxTime != null) {
        writeFileAtomic(watermarkPath, JSON.stringify({ maxTime: result.maxTime }, null, 2) + "\n");
    }
    return result;
};

// ---------- CLI (B1.3, B1.8) ----------

export const parseArgs = (argv: string[]): ParsedArgs => {
    const out: ParsedArgs = {
        channelIds: [],
        from: null,
        to: null,
        sessionGapMinutes: 60,
        incremental: false,
        outDir: "export",
    };
    // nextValue <i> <eq> — the value for the option at argv[i]; --flag=value
    // uses the inline part, otherwise consume the following argument.
    const nextValue = (i: number, eq: number, flag: string): { value: string; next: number } => {
        if (eq >= 0) return { value: argv[i].slice(eq + 1), next: i };
        const value = argv[i + 1];
        if (value == null || value.startsWith("--")) {
            throw new Error(`missing value for ${flag}`);
        }
        return { value, next: i + 1 };
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.indexOf("=");
        const name = eq >= 0 ? arg.slice(0, eq) : arg;
        switch (name) {
            case "--password": {
                const v = nextValue(i, eq, "--password");
                out.password = v.value;
                i = v.next;
                break;
            }
            case "--guild": {
                const v = nextValue(i, eq, "--guild");
                out.guildId = v.value;
                i = v.next;
                break;
            }
            case "--channels": {
                const v = nextValue(i, eq, "--channels");
                out.channelIds = v.value.split(",").map((s) => s.trim()).filter(Boolean);
                i = v.next;
                break;
            }
            case "--from": {
                const v = nextValue(i, eq, "--from");
                out.from = v.value;
                i = v.next;
                break;
            }
            case "--to": {
                const v = nextValue(i, eq, "--to");
                out.to = v.value;
                i = v.next;
                break;
            }
            case "--incremental": out.incremental = true; break;
            case "--session-gap-minutes": {
                const v = nextValue(i, eq, "--session-gap-minutes");
                const n = Number(v.value);
                if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --session-gap-minutes: '${v.value}'`);
                out.sessionGapMinutes = n;
                i = v.next;
                break;
            }
            case "--out": {
                const v = nextValue(i, eq, "--out");
                if (v.value.length === 0) throw new Error("--out directory path cannot be empty");
                out.outDir = v.value;
                i = v.next;
                break;
            }
            default: throw new Error(`unknown option: ${arg}`);
        }
    }
    return out;
};

export const main = async (argv: string[]): Promise<void> => {
    const args = parseArgs(argv);
    const password = args.password ?? process.env.PASSWORD;
    const guildId = args.guildId ?? process.env.GUILD_ID?.trim() ?? null;

    if (!fs.existsSync("server.db")) {
        console.error("error: server.db not found — run the bot first so server.db is created");
        process.exitCode = 1;
        return;
    }

    const outDir = path.resolve(args.outDir);
    const options: ExportOptions = {
        guildId,
        password,
        channelIds: args.channelIds,
        from: args.from,
        to: args.to,
        sessionGapMinutes: args.sessionGapMinutes,
        incremental: args.incremental,
        watermark: readWatermark(outDir),
    };

    const sequelize = new Sequelize({
        dialect: "sqlite",
        storage: "server.db",
        logging: false,
        dialectOptions: { mode: sqlite3.OPEN_READONLY },
    });
    try {
        const result = await runExport(sequelize, options, outDir);
        console.log(
            `exported ${result.emittedCount} message(s) (mode ${result.output.mode}) → ${path.join(outDir, "messages.json")}`
        );
    } finally {
        await sequelize.close();
    }
};

// run only when this file is the entry point, so verify scripts can import the
// pure functions without triggering an export
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    main(process.argv.slice(2)).catch((err: any) => {
        console.error(`export failed: ${err?.message ?? err}`);
        process.exitCode = 1;
    });
}
