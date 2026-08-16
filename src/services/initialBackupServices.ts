
/**
 * We are using a multithreaded approach
 * Where we 
 * 1. Load up all_channels array with all the channels we need to scrape
 * 2. Spawn instances of initial_backup_process, this process will pull channels from the array and work on it each at a time. More processes = more hands (faster)
 */

import consola from "consola";
import { Collection, GuildTextBasedChannel, Message } from "discord.js";
import { get_msg_content, save_msg_to_db } from "./messageServices";
import { fetch_channels } from "./channelServices";
import { guild_id, initial_backup, initial_backup_force_fresh, initial_backup_worker_count } from "../config/config";
import { attachments_model, channels_model, client, initial_backup_checkpoints_model, initial_backup_progress_model, messages_model, sequelize, users_model } from "..";

type ChannelUnit = {
    channel: GuildTextBasedChannel;
    cursor?: Message;
};

let all_channels: ChannelUnit[] = [];
let get_a_channel = () => all_channels.pop();

//stats
let processed_total = 0;
let channels_total = 0;
let channels_done = 0;
let number_of_processes = initial_backup_worker_count;
let startedAt = 0;

//every checkpoint write is isolated — a failure is logged, never fatal (Decision 5)
const upsert_checkpoint = async (channelId: string, status: string, lastMessageId: string | undefined) => {
    try{
        await initial_backup_checkpoints_model.upsert({
            channelId,
            status,
            lastMessageId: lastMessageId ?? null
        });
    }catch(err: any){
        consola.error(`Failed to write checkpoint for ${channelId}: ${err.message}`);
    }
};

const upsert_progress = async (status: string) => {
    try{
        await initial_backup_progress_model.upsert({
            id: 1,
            processedTotal: processed_total,
            channelsDone: channels_done,
            channelsTotal: channels_total,
            startedAt,
            lastUpdated: Date.now(),
            status
        });
    }catch(err: any){
        consola.error(`Failed to write progress row: ${err.message}`);
    }
};

const count_checkpoints = async () => {
    try{
        return await initial_backup_checkpoints_model.count();
    }catch(err: any){
        consola.error(`Failed to count checkpoints: ${err.message}`);
        return 0;
    }
};

const count_complete_checkpoints = async () => {
    try{
        return await initial_backup_checkpoints_model.count({where: {status: 'complete'}});
    }catch(err: any){
        consola.error(`Failed to count complete checkpoints: ${err.message}`);
        return 0;
    }
};

export const initial_backup_scraper = async () => {
    try{        
        if(!initial_backup) return;

        consola.warn("Starting Initial Back Up... Please change configs from .env if you dont want this to happen");
        startedAt = Date.now();

        if(!guild_id) throw new Error('Please set a proper "guild_id" in .env');

        //force-fresh opt-out: drop every checkpoint + progress row, crawl from scratch
        if(initial_backup_force_fresh){
            try{
                await initial_backup_checkpoints_model.destroy({where: {}});
                await initial_backup_progress_model.destroy({where: {}});
                consola.warn("INITIAL_BACKUP_FORCE_FRESH is enabled — clearing checkpoints, crawling fresh.");
            }catch(err: any){
                consola.error(`Failed to clear checkpoints: ${err.message}`);
            }
        }

        const checkpoints: any[] = await initial_backup_checkpoints_model.findAll();

        if(checkpoints.length === 0){
            //fresh path (Decision 3): seed every top-level channel as a pending row
            const channels = await fetch_channels(guild_id);
            for(const channel of channels){
                await upsert_checkpoint(channel.id, 'pending', undefined);
                all_channels.push({channel, cursor: undefined});
            }
        }else{
            //resume path (Decision 3): resolve incomplete rows to channel objects
            for(const row of checkpoints){
                if(row.status === 'complete') continue; //complete → skip

                let channel: GuildTextBasedChannel | null = null;
                try{
                    channel = await client.channels.fetch(row.channelId) as GuildTextBasedChannel | null;
                }catch(err: any){
                    channel = null;
                }

                if(!channel){
                    //deleted channel → mark complete + skip (Decision 3)
                    await upsert_checkpoint(row.channelId, 'complete', undefined);
                    continue;
                }

                //pending → no cursor; in_progress → resume from lastMessageId (before: is exclusive, Decision 3)
                const cursor = row.status === 'in_progress' && row.lastMessageId ? {id: row.lastMessageId} as Message : undefined;
                all_channels.push({channel, cursor});
            }

            //new-channel detection on resume (Decision 9): current top-level text channels with no row → pending
            const channels = await fetch_channels(guild_id);
            const known_ids = new Set(checkpoints.map(c => c.channelId));
            for(const channel of channels){
                if(known_ids.has(channel.id)) continue;
                await upsert_checkpoint(channel.id, 'pending', undefined);
                all_channels.push({channel, cursor: undefined});
            }

            //restore cumulative counters from the singleton so progress never goes backward (Decision 6)
            try{
                const progress: any = await initial_backup_progress_model.findByPk(1);
                if(progress){
                    processed_total = progress.processedTotal ?? 0;
                    startedAt = progress.startedAt ?? Date.now();
                }
            }catch(err: any){
                consola.error(`Failed to restore progress counters: ${err.message}`);
            }
        }

        //Decision 2: denominator = checkpoint rows (top-level + threads); done = complete rows
        channels_total = await count_checkpoints();
        channels_done = await count_complete_checkpoints();
        await upsert_progress('running');

        let proceses = [];

        for(let i = 0; i<number_of_processes; i++){
            consola.info(`Spawning process ${i+1}/${number_of_processes}`);
            proceses.push(initial_backup_process());
        }

        //wrap Promise.all so one worker failure never kills the crawl (Decision 5)
        try{
            await Promise.all(proceses);
        }catch(err: any){
            consola.error(`Err at /services/initialBackupServices.ts/initial_backup_scraper() awaiting processes: ${err.message}`);
        }

        await upsert_progress('finished');

        consola.success("Initial Backup Complete!");
    }catch(err: any){
        consola.error("Err at /services/initialBackupServices.ts/initial_backup_scraper()");
        console.log(err);
        throw new Error(err.message);
    }
}

//this works with 1 channel at a time
export const initial_backup_process = async () => {
    try{
        do{
            const unit = get_a_channel();
            if(!unit) break; //successfully went through all the channels

            //per-channel isolation: failure leaves the channel in_progress, crawl continues (Decision 5)
            try{
                await upsert_checkpoint(unit.channel.id, 'in_progress', unit.cursor?.id);
                await crawl_channel(unit.channel, unit.cursor);

                channels_done++;
                await upsert_checkpoint(unit.channel.id, 'complete', undefined);
            }catch(err: any){
                consola.error(`Failed on channel ${unit.channel.id}: ${err.message}`);
            }
        }while(all_channels.length!==0);
    }catch(err: any){
        consola.error("Err at /services/initialBackupServices.ts/initial_backup_process()");
        console.log(err);
    }
}

const crawl_channel = async (channel: GuildTextBasedChannel, start_cursor: Message | undefined) => {
    let cursor: Message | undefined = start_cursor;
    let fetched_messages = new Collection<string, Message>();;

    do{
        if(!channel.messages) break; //this means the channel is a category channel

        fetched_messages = !cursor ? await channel.messages.fetch({limit: 100}) : await channel.messages.fetch({limit: 100, before: cursor.id});
        if(fetched_messages.size === 0) break; //incase there is nothing on the response, since the while statement cant pick it up this iteration. maybe I should use a regular while loop, but too lazy

        processed_total += fetched_messages.size;

        cursor = Array.from(fetched_messages)[fetched_messages.size-1][1]; //setting the last message, this is very important so we can keep the loop going

        for(let raw_msg of fetched_messages){
            const msg = raw_msg[1];
            
            const raw_data = await get_msg_content(msg);
            await save_msg_to_db(raw_data, messages_model, attachments_model, users_model, channels_model)

            if(raw_data.thread){
                //thread rows are written at enqueue so a crash never loses them (Decision 4)
                channels_total++;
                await upsert_checkpoint(raw_data.thread.id, 'pending', undefined);
                all_channels.push({channel: raw_data.thread, cursor: undefined});
            }
        }

        //one transaction per page: cursor + progress counters stay consistent (Decision 6)
        try{
            const cursor_id = cursor.id; //captured before the closure so TS can narrow it
            await sequelize.transaction(async (t) => {
                await initial_backup_checkpoints_model.upsert({
                    channelId: channel.id,
                    status: 'in_progress',
                    lastMessageId: cursor_id
                }, {transaction: t});

                await initial_backup_progress_model.upsert({
                    id: 1,
                    processedTotal: processed_total,
                    channelsDone: channels_done,
                    channelsTotal: channels_total,
                    startedAt,
                    lastUpdated: Date.now(),
                    status: 'running'
                }, {transaction: t});
            });
        }catch(err: any){
            consola.error(`Failed to persist checkpoint for ${channel.id}: ${err.message}`);
        }

        //logging
        consola.success(`${channels_done}/${channels_total} Total Msg Processed: ${processed_total} Seconds Passed: ${((Date.now()-startedAt)/1000).toFixed(0)} Last: ${cursor.url}`);
    }while(fetched_messages.size===100);
}
