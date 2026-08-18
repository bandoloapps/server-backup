import { Message, blockQuote } from "discord.js";
import { AttachmentData, ExtractedContent, MessageData } from "../..";
import { encrypt } from "./encryptionServices";
import { ignore_channels, ignore_users } from "../config/config";
import { upsert_cache_for_message } from "./cacheServices";
import consola from "consola";

export const fetch_and_save_msgs = async (channelId: string) => {
    try{

    }catch(err: any){
        consola.error("Err at /services/messageServices.ts/fetch_and_save_msgs()");
        console.log(err);
        throw new Error(err.message);
    }   
}

export const get_msg_content = async (msg: Message) => {
    try{
        
        let data: ExtractedContent = {
            channelId: msg.channelId,
            userId: msg.author.id,
            messageId: msg.id,
            time: new Date(msg.createdTimestamp).getTime(),
            text: msg.content,
            attachments: new Map<string, Buffer>(),
            thread: null,
            author: {
                username: msg.author.username,
                displayName: msg.author.displayName,
                globalName: msg.author.globalName
            },
            channel: {
                name: 'name' in msg.channel ? msg.channel.name : null,
                type: msg.channel.isThread() ? 'thread' : 'text',
                parentId: msg.channel.isThread() ? (msg.channel.parentId ?? null) : null
            }
        }

        //fetching attachments
        const attachments_raw = msg.attachments.map(v => v);        
        for(let attachment of attachments_raw){
            
            const attachment_data = await (await fetch(attachment.url)).arrayBuffer();
            if(!attachment_data) continue;

            const buffer = Buffer.from(attachment_data);
            const [raw_name, extension] = attachment.name.split(".");

            const name = `${raw_name}__${Date.now()}.${extension}`;

           data.attachments.set(name, buffer);
        }


        //fetching thread
        if(!msg.hasThread) return data;

        const thread = await msg.thread?.fetch();

        if(!thread) return data;
    
        data.thread = thread;

        return data;
    }catch(err: any){
        consola.error("Err at /services/messageServices.ts/fetch_msg_content()");
        console.log(err);
        throw new Error(err.message);
    }
}

export const save_msg_to_db = async (raw_data: ExtractedContent, messages_model: any, attachments_model: any, users_model: any, channels_model: any) => {
    try{
        const {channelId, messageId, userId, time, text, attachments: attachments_raw, thread} = raw_data;

        //cache user/channel/thread names — a cache failure never blocks the message save (D4).
        //Run BEFORE the duplicate guard so a re-crawl (INITIAL_BACKUP_FORCE_FRESH) re-populates the
        //users/channels cache for messages that already exist; otherwise the cache only ever fills
        //for brand-new messages and existing rows never resolve their names on export.
        await upsert_cache_for_message(raw_data, users_model, channels_model);

        //making sure we arent working on a duplicate
        const previous_message = await messages_model.findOne({where: {messageId}});
        if(previous_message) return;

        //ignoring from configs
        if(ignore_channels.includes(channelId)) return;
        if(ignore_users.includes(userId)) return;

        const attachments = Array.from(attachments_raw);

        //extracting & encrypting message data
        const message_data: MessageData = {
            channelId,
            messageId,
            userId,
            time,
            text: encrypt(Buffer.from(text)),
            attachments: attachments.map(v=> v[0]).join(',')
        }

        //extracing & encrypting attachment data

        for(let attachment of attachments){
            let data: AttachmentData = {
                name: attachment[0],
                messageId,
                data: encrypt(attachment[1])
            };
            await attachments_model.create(data); //if you are wondering why we are not using a bulkCreate, because the query can sometimes exceed javascript string length limit
        }

        //saving it to DB

        await messages_model.create(message_data)
    }catch(err: any){
        consola.error("Err at /services/messageServices.ts/save_msg_to_db()");
        console.log(err);
        throw new Error(err.message);
    }
}

export const update_msg_to_db = async (raw_data: ExtractedContent, messages_model: any, attachments_model: any, users_model: any, channels_model: any) => {
    try{
        const {channelId, messageId, userId, time, text, attachments: attachments_raw, thread} = raw_data;
        
        //ignoring from configs
        if(ignore_channels.includes(channelId)) return;
        if(ignore_users.includes(userId)) return;

        //cache user/channel/thread names on edit path too — edits are the dominant live path,
        //so without this cache rows go stale (review fix). Failure never blocks the message update (D4).
        try {
            await upsert_cache_for_message(raw_data, users_model, channels_model);
        } catch(err: any) {
            consola.error(`Failed to upsert cache on edit path for ${messageId}: ${err.message}`);
        }

        //making sure we have smth to update
        const previous_message = await messages_model.findOne({where: {messageId}});
        if(previous_message) {
            const attachments = Array.from(attachments_raw);

            //extracting & encrypting message data
            const message_data: MessageData = {
                channelId,
                messageId,
                userId,
                time,
                text: encrypt(Buffer.from(text)),
                attachments: attachments.map(v=> v[0]).join(',')
            }
    
            //extracing & encrypting attachment data
    
            for(let attachment of attachments){
                let data: AttachmentData = {
                    name: attachment[0],
                    messageId,
                    data: encrypt(attachment[1])
                };
                await attachments_model.create(data); //if you are wondering why we are not using a bulkCreate, because the query can sometimes exceed javascript string length limit
            }
    
            //updating model
            await previous_message.update(message_data)
        };
    }catch(err: any){
        consola.error("Err at /services/messageServices.ts/save_msg_to_db()");
        console.log(err);
        throw new Error(err.message);
    }
}