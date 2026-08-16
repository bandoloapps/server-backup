import { AnyThreadChannel } from "discord.js"

type ExtractedContent = {
    channelId: string,
    userId: string,
    messageId: string,
    time: number,
    text: string,
    attachments: Map<string, Buffer>,
    thread: AnyThreadChannel | null,
    author: {
        username: string | null,
        displayName: string | null,
        globalName: string | null
    } | null,
    channel: {
        name: string | null,
        type: 'text' | 'thread',
        parentId: string | null
    } | null
}

type MessageData = {
    channelId: string,
    userId: string,
    messageId: string,
    time: number,
    text: Buffer,
    attachments: string,
}

type AttachmentData = {
    messageId: string,
    name: string,
    data: Buffer
}