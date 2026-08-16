import consola from "consola";
import { ExtractedContent } from "../..";

/**
 * Upserts the users/channels cache rows for one message at the single capture
 * point (save_msg_to_db). Each table is isolated in its own try/catch (D4):
 * a cache failure is logged and swallowed, never thrown, so message
 * persistence is never blocked.
 *
 * Models are passed in so the logic stays testable without importing the
 * client-side index (which instantiates the Client at load).
 */
export const upsert_cache_for_message = async (
    raw_data: ExtractedContent,
    users_model: any,
    channels_model: any
) => {
    //user cache row — failure is logged, never thrown (D4)
    try{
        if(raw_data.author){
            await users_model.upsert({
                userId: raw_data.userId,
                username: raw_data.author.username,
                displayName: raw_data.author.displayName,
                globalName: raw_data.author.globalName
            });
        }
    }catch(err: any){
        consola.error(`Failed to upsert user cache for ${raw_data.userId}: ${err.message}`);
    }

    //channel cache row — failure is logged, never thrown (D4)
    try{
        if(raw_data.channel){
            await channels_model.upsert({
                channelId: raw_data.channelId,
                name: raw_data.channel.name,
                type: raw_data.channel.type,
                parentId: raw_data.channel.parentId
            });
        }
    }catch(err: any){
        consola.error(`Failed to upsert channel cache for ${raw_data.channelId}: ${err.message}`);
    }

    //thread channel row from raw_data.thread (D2) — failure is logged, never thrown (D4)
    if(raw_data.thread){
        try{
            await channels_model.upsert({
                channelId: raw_data.thread.id,
                name: raw_data.thread.name,
                type: 'thread',
                parentId: raw_data.thread.parentId ?? null
            });
        }catch(err: any){
            consola.error(`Failed to upsert thread cache for ${raw_data.thread.id}: ${err.message}`);
        }
    }
}
