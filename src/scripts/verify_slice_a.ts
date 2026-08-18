/**
 * Slice A verification — users/channels cache (SDD change: message-export).
 *
 * The fork has no TS test framework, so this script is the test layer for
 * Slice A. It exercises the REAL production code (model factories + the
 * cache-upsert helper + get_msg_content + save_msg_to_db) against a scratch
 * SQLite DB and exits non-zero on any failed assertion. It mirrors the live
 * sqlite3 checks from the design (A4):
 *   - users/channels tables exist with the right PK columns
 *   - a users row carries the expected username/displayName/globalName
 *   - a thread channels row has type='thread' and parentId set
 *   - messages COUNT is unchanged by additive sync and cache upserts
 *   - end-to-end: real get_msg_content -> real save_msg_to_db lands rows
 *   - edge cases: empty username, DMChannel guard, thread parentId null,
 *     channels-table failure, sync throw from upsert
 *
 * 62 asserts total.
 *
 * Run after build: node dist/scripts/verify_slice_a.js
 */
import os from "os";
import path from "path";
import fs from "fs";
import { Sequelize } from "sequelize";
import { define_messages } from "../database/models/messages";
import { define_attachments } from "../database/models/attachments";
import { define_users } from "../database/models/users";
import { define_channels } from "../database/models/channels";
import { upsert_cache_for_message } from "../services/cacheServices";
import { get_msg_content, save_msg_to_db } from "../services/messageServices";

const DB_PATH = path.join(os.tmpdir(), "slice_a_verify.db");

let failed = 0;
const check = (name: string, cond: boolean) => {
    if (!cond) {
        failed++;
        console.error(`FAIL: ${name}`);
    } else {
        console.log(`PASS: ${name}`);
    }
};

const main = async () => {
    //fresh scratch DB per run — a leftover file must never change the seed counts
    if(fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

    const sequelize = new Sequelize({ dialect: "sqlite", storage: DB_PATH, logging: false });

    try {
        // ---- Phase 1: pre-existing DB with messages only (additive-safety setup) ----
        const messages_model = define_messages(sequelize);
        const attachments_model = define_attachments(sequelize);
        await sequelize.sync({ alter: true });
        await messages_model.bulkCreate([
            { channelId: "ch-text-1", userId: "u-1", messageId: "m-1", time: 1000, text: Buffer.from("hello") },
            { channelId: "ch-thread-1", userId: "u-2", messageId: "m-2", time: 2000, text: Buffer.from("world") },
        ]);
        const count_before = await messages_model.count();
        check("pre-existing messages seeded (count 2)", count_before === 2);

        // ---- Phase 2: register new models + additive sync (mirrors src/index.ts) ----
        const users_model = define_users(sequelize);
        const channels_model = define_channels(sequelize);
        await sequelize.sync({ alter: true });

        const tables = (await sequelize.query(
            "SELECT name FROM sqlite_master WHERE type='table'", { type: "SELECT" }
        )).map((r: any) => r.name);
        check("users table created", tables.includes("users"));
        check("channels table created", tables.includes("channels"));
        check("messages table preserved", tables.includes("messages"));

        const users_cols = await sequelize.query("PRAGMA table_info(users)", { type: "SELECT" }) as any[];
        const users_names = users_cols.map(c => c.name);
        check("users has userId", users_names.includes("userId"));
        check("users has username", users_names.includes("username"));
        check("users has displayName", users_names.includes("displayName"));
        check("users has globalName", users_names.includes("globalName"));
        const pk_users = users_cols.filter(c => c.pk === 1).map(c => c.name);
        check("users PK is userId", pk_users.length === 1 && pk_users[0] === "userId");

        const ch_cols = await sequelize.query("PRAGMA table_info(channels)", { type: "SELECT" }) as any[];
        const ch_names = ch_cols.map(c => c.name);
        check("channels has channelId", ch_names.includes("channelId"));
        check("channels has name", ch_names.includes("name"));
        check("channels has type", ch_names.includes("type"));
        check("channels has parentId", ch_names.includes("parentId"));
        const pk_ch = ch_cols.filter(c => c.pk === 1).map(c => c.name);
        check("channels PK is channelId", pk_ch.length === 1 && pk_ch[0] === "channelId");

        const count_after_sync = await messages_model.count();
        check("messages COUNT unchanged after additive sync", count_after_sync === 2);

        // ---- Phase 3: cache upserts via the real helper ----
        const msg1 = {
            channelId: "ch-text-1", userId: "u-1", messageId: "m-1", time: 1000, text: "hello",
            attachments: new Map<string, Buffer>(), thread: null,
            author: { username: "alice", displayName: "Alice", globalName: "Alice G" },
            channel: { name: "general", type: "text" as "text" | "thread", parentId: null },
        };
        await upsert_cache_for_message(msg1, users_model, channels_model);

        const user1: any = await users_model.findByPk("u-1");
        check("users row username", user1?.username === "alice");
        check("users row displayName", user1?.displayName === "Alice");
        check("users row globalName", user1?.globalName === "Alice G");

        const ch1: any = await channels_model.findByPk("ch-text-1");
        check("channel row name", ch1?.name === "general");
        check("channel row type text", ch1?.type === "text");
        check("channel row parentId null", ch1?.parentId === null);

        // message with a thread (raw_data.thread after get_msg_content fetches it)
        const msg2 = {
            channelId: "ch-thread-1", userId: "u-2", messageId: "m-2", time: 2000, text: "world",
            attachments: new Map<string, Buffer>(),
            thread: { id: "th-1", name: "thread-one", parentId: "ch-text-1" } as any,
            author: { username: "bob", displayName: "bob", globalName: null },
            channel: { name: "thread-one", type: "thread" as "text" | "thread", parentId: "ch-text-1" },
        };
        await upsert_cache_for_message(msg2, users_model, channels_model);

        const user2: any = await users_model.findByPk("u-2");
        check("second users row username", user2?.username === "bob");
        check("second users row globalName null", user2?.globalName === null);

        const thread: any = await channels_model.findByPk("th-1");
        check("thread row exists", !!thread);
        check("thread row name", thread?.name === "thread-one");
        check("thread row type thread", thread?.type === "thread");
        check("thread row parentId", thread?.parentId === "ch-text-1");

        // upsert must update in place, never duplicate (rename alice)
        await upsert_cache_for_message({
            ...msg1,
            author: { username: "alice2", displayName: "Alice 2", globalName: null },
        }, users_model, channels_model);
        const user1b: any = await users_model.findByPk("u-1");
        const user_rows = await users_model.count();
        check("upsert updates existing row", user1b?.username === "alice2" && user1b?.globalName === null);
        check("upsert does not duplicate users rows", user_rows === 2);

        // missing author/channel fields never fail (D4)
        const msg3 = {
            channelId: "ch-text-1", userId: "u-1", messageId: "m-3", time: 3000, text: "no-meta",
            attachments: new Map<string, Buffer>(), thread: null, author: null, channel: null,
        };
        await upsert_cache_for_message(msg3, users_model, channels_model);
        check("missing author/channel does not throw", true);

        // a cache failure is swallowed; the other table's row is still written (D4)
        const broken: any = { upsert: async () => { throw new Error("boom"); } };
        let threw = false;
        try {
            await upsert_cache_for_message(msg1, broken, channels_model);
        } catch (e: any) {
            threw = true;
        }
        check("cache upsert failure swallowed", !threw);
        const ch1b: any = await channels_model.findByPk("ch-text-1");
        check("channel row written despite user-cache failure", !!ch1b);

        const count_after_cache = await messages_model.count();
        check("messages COUNT unchanged after cache upserts", count_after_cache === 2);

        // ---- Phase 4: end-to-end via real get_msg_content + save_msg_to_db ----
        // Build a minimal stub discord.js-like Message object and run the REAL
        // get_msg_content against it, then feed its output into the REAL save_msg_to_db.
        // Note: msg.attachments must be a Collection-like object with a .map() method.
        const emptyAttachments = { map: (fn: any) => [] } as any;

        const stubMsg = {
            id: "m-e2e-1",
            channelId: "ch-e2e-text",
            createdTimestamp: 5000,
            content: "end-to-end test",
            author: {
                id: "u-e2e-1",
                username: "e2e_user",
                displayName: "E2E User",
                globalName: "E2E Global"
            },
            channel: {
                name: "e2e-channel",
                isThread: () => false,
                parentId: null
            },
            attachments: emptyAttachments,
            hasThread: false,
            thread: null
        } as any;

        const extracted = await get_msg_content(stubMsg);
        check("get_msg_content populates author.username", extracted.author?.username === "e2e_user");
        check("get_msg_content populates author.displayName", extracted.author?.displayName === "E2E User");
        check("get_msg_content populates author.globalName", extracted.author?.globalName === "E2E Global");
        check("get_msg_content populates channel.name", extracted.channel?.name === "e2e-channel");
        check("get_msg_content populates channel.type text", extracted.channel?.type === "text");
        check("get_msg_content populates channel.parentId null", extracted.channel?.parentId === null);

        await save_msg_to_db(extracted, messages_model, attachments_model, users_model, channels_model);

        const e2e_user: any = await users_model.findByPk("u-e2e-1");
        check("save_msg_to_db lands users row (e2e)", e2e_user?.username === "e2e_user");
        check("save_msg_to_db lands users row displayName (e2e)", e2e_user?.displayName === "E2E User");
        check("save_msg_to_db lands users row globalName (e2e)", e2e_user?.globalName === "E2E Global");

        const e2e_ch: any = await channels_model.findByPk("ch-e2e-text");
        check("save_msg_to_db lands channels row (e2e)", e2e_ch?.name === "e2e-channel");
        check("save_msg_to_db lands channels row type (e2e)", e2e_ch?.type === "text");

        const e2e_msg: any = await messages_model.findOne({ where: { messageId: "m-e2e-1" } });
        check("save_msg_to_db lands message row (e2e)", !!e2e_msg);
        check("save_msg_to_db message has correct userId (e2e)", e2e_msg?.userId === "u-e2e-1");

        // Thread variant: stub message with thread
        const stubThreadMsg = {
            id: "m-e2e-thread-1",
            channelId: "ch-e2e-thread",
            createdTimestamp: 6000,
            content: "thread test",
            author: {
                id: "u-e2e-2",
                username: "thread_user",
                displayName: "Thread User",
                globalName: null
            },
            channel: {
                name: "thread-channel",
                isThread: () => true,
                parentId: "ch-e2e-parent"
            },
            attachments: emptyAttachments,
            hasThread: true,
            thread: {
                fetch: async () => ({
                    id: "th-e2e-1",
                    name: "e2e-thread",
                    parentId: "ch-e2e-parent"
                })
            }
        } as any;

        const extractedThread = await get_msg_content(stubThreadMsg);
        check("get_msg_content thread type", extractedThread.channel?.type === "thread");
        check("get_msg_content thread parentId", extractedThread.channel?.parentId === "ch-e2e-parent");
        check("get_msg_content thread raw_data.thread populated", !!extractedThread.thread);

        await save_msg_to_db(extractedThread, messages_model, attachments_model, users_model, channels_model);

        const thread_ch: any = await channels_model.findByPk("th-e2e-1");
        check("save_msg_to_db lands thread channels row", !!thread_ch);
        check("save_msg_to_db thread row type is 'thread'", thread_ch?.type === "thread");
        check("save_msg_to_db thread row has parentId", thread_ch?.parentId === "ch-e2e-parent");
        check("save_msg_to_db thread row has name", thread_ch?.name === "e2e-thread");

        // ---- Edge cases ----
        // Empty/blank username capture
        const stubEmptyUser = {
            id: "m-empty-user",
            channelId: "ch-empty",
            createdTimestamp: 7000,
            content: "empty user test",
            author: {
                id: "u-empty",
                username: "",
                displayName: "",
                globalName: null
            },
            channel: {
                name: "empty-channel",
                isThread: () => false,
                parentId: null
            },
            attachments: emptyAttachments,
            hasThread: false,
            thread: null
        } as any;

        const extractedEmpty = await get_msg_content(stubEmptyUser);
        check("get_msg_content handles empty username", extractedEmpty.author?.username === "");
        await save_msg_to_db(extractedEmpty, messages_model, attachments_model, users_model, channels_model);
        const empty_user: any = await users_model.findByPk("u-empty");
        check("save_msg_to_db lands row with empty username", empty_user?.username === "");

        // DMChannel guard: 'name' in msg.channel false → channel name null
        const stubDM = {
            id: "m-dm-1",
            channelId: "ch-dm-1",
            createdTimestamp: 8000,
            content: "dm test",
            author: {
                id: "u-dm-1",
                username: "dm_user",
                displayName: "DM User",
                globalName: null
            },
            channel: {
                // DMChannel has no 'name' property
                isThread: () => false,
                parentId: null
            },
            attachments: emptyAttachments,
            hasThread: false,
            thread: null
        } as any;

        const extractedDM = await get_msg_content(stubDM);
        check("get_msg_content DMChannel guard: channel.name is null", extractedDM.channel?.name === null);
        await save_msg_to_db(extractedDM, messages_model, attachments_model, users_model, channels_model);
        const dm_ch: any = await channels_model.findByPk("ch-dm-1");
        check("save_msg_to_db lands DM channel row with null name", dm_ch?.name === null);

        // Thread with parentId: null (the ?? null branch in cacheServices.ts)
        const stubThreadNullParent = {
            id: "m-thread-null-parent",
            channelId: "ch-thread-null",
            createdTimestamp: 9000,
            content: "thread null parent",
            author: {
                id: "u-thread-null",
                username: "thread_null_user",
                displayName: "Thread Null",
                globalName: null
            },
            channel: {
                name: "thread-null",
                isThread: () => true,
                parentId: null
            },
            attachments: emptyAttachments,
            hasThread: true,
            thread: {
                fetch: async () => ({
                    id: "th-null-parent",
                    name: "thread-null-name",
                    parentId: null
                })
            }
        } as any;

        const extractedThreadNull = await get_msg_content(stubThreadNullParent);
        await save_msg_to_db(extractedThreadNull, messages_model, attachments_model, users_model, channels_model);
        const thread_null: any = await channels_model.findByPk("th-null-parent");
        check("thread with parentId null lands with parentId null", thread_null?.parentId === null);

        // Channels-table failure swallowed (only users-table failure was tested before)
        const broken_channels: any = { upsert: async () => { throw new Error("channels boom"); } };
        let channels_threw = false;
        try {
            await upsert_cache_for_message(msg1, users_model, broken_channels);
        } catch (e: any) {
            channels_threw = true;
        }
        check("channels-table upsert failure swallowed", !channels_threw);
        const user_after_ch_fail: any = await users_model.findByPk("u-1");
        check("users row written despite channels-table failure", !!user_after_ch_fail);

        // Synchronous (non-async) throw from upsert does not break the save path
        const sync_broken: any = { upsert: () => { throw new Error("sync boom"); } };
        let sync_threw = false;
        try {
            await upsert_cache_for_message(msg1, sync_broken, channels_model);
        } catch (e: any) {
            sync_threw = true;
        }
        check("sync throw from upsert swallowed", !sync_threw);

        // Regression: a re-crawl (INITIAL_BACKUP_FORCE_FRESH) processes messages that already
        // exist in the DB. The cache upsert must run BEFORE the duplicate guard, otherwise
        // existing messages never populate users/channels and export falls back to unknown (<id>).
        // See save_msg_to_db ordering fix.
        const recrawl_content = {
            channelId: "ch-e2e",
            userId: "u-recrawl",
            messageId: "msg-e2e-existing",
            time: 1700000000000,
            text: "existing message",
            attachments: emptyAttachments,
            thread: null,
            author: { username: "recrawl_user", displayName: "Recrawl User", globalName: "Recrawl Global" },
            channel: { name: "recrawl-channel", type: "text", parentId: null }
        } as any;
        // first save: message + cache rows land normally
        await save_msg_to_db(recrawl_content, messages_model, attachments_model, users_model, channels_model);
        // simulate the re-crawl: same messageId already exists, save_msg_to_db returns at the
        // duplicate guard; the cache upsert must still run before that guard.
        await save_msg_to_db(recrawl_content, messages_model, attachments_model, users_model, channels_model);
        const recrawl_msg_count = await messages_model.count({ where: { messageId: "msg-e2e-existing" } });
        check("duplicate save does not insert a second message row", recrawl_msg_count === 1);
        const recrawl_user: any = await users_model.findByPk("u-recrawl");
        check("duplicate save still populates users cache (regression)", recrawl_user?.username === "recrawl_user");
        const recrawl_ch: any = await channels_model.findByPk("ch-e2e");
        check("duplicate save still populates channels cache (regression)", recrawl_ch?.name === "recrawl-channel");

        const count_final = await messages_model.count();
        check("messages COUNT unchanged after all phases", count_final === 8);

        console.log(failed === 0
            ? `\nALL CHECKS PASSED (db: ${DB_PATH})`
            : `\n${failed} CHECKS FAILED (db: ${DB_PATH})`);
    } finally {
        await sequelize.close();
        if(fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    }
    process.exit(failed === 0 ? 0 : 1);
};

main().catch((err: any) => {
    console.error(err);
    process.exit(2);
});
