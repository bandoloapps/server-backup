import { Collection, GuildTextBasedChannel, NonThreadGuildBasedChannel } from "discord.js";
import { client } from "..";
import consola from "consola";
import { ignore_channels } from "../config/config";
import { filter_ignored_channels } from "./initialBackupIncremental";

export const fetch_channels = async (guildId: string) => {
    try{
        if(!client.isReady()) throw new Error("Client is not ready.");

        const guild = await client.guilds.fetch(guildId);

        if(!guild) throw new Error('Guild not found.');

        let all_channels = (await guild.channels.fetch()).filter(v => v !== null);

        all_channels = all_channels.filter(v => v?.isTextBased);

        let final = all_channels.map( v => v as GuildTextBasedChannel);

        //R4: ignore_channels filtered at the source — covers fresh seed + new-channel detection
        return filter_ignored_channels(final, ignore_channels);
    }catch(err: any){
        consola.error("Err at /services/channelServices.ts/fetch_channels()");
        console.log(err);
        throw new Error(err.message);
    }
}