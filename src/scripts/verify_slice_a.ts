/**
 * Slice A verification — users/channels cache (SDD change: message-export).
 *
 * The fork has no TS test framework, so this script is the test layer for
 * Slice A. It exercises the REAL production code (model factories + the
 * cache-upsert helper) against a scratch SQLite DB and exits non-zero on any
 * failed assertion. It mirrors the live sqlite3 checks from the design (A4):
 *   - users/channels tables exist with the right PK columns
 *   - a users row carries the expected username/displayName/globalName
 *   - a thread channels row has type='thread' and parentId set
 *   - messages COUNT is unchanged by additive sync and cache upserts
 *
 * Run after build: node dist/scripts/verify_slice_a.js
 */
import os from "os";
import path from "path";
import fs from "fs";
import { Sequelize } from "sequelize";
import { define_messages } from "../database/models/messages";
import { define_users } from "../database/models/users";
import { define_channels } from "../database/models/channels";
import { upsert_cache_for_message } from "../services/cacheServices";

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

    // ---- Phase 1: pre-existing DB with messages only (additive-safety setup) ----
    const messages_model = define_messages(sequelize);
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

    await sequelize.close();
    console.log(failed === 0
        ? `\nALL CHECKS PASSED (db: ${DB_PATH})`
        : `\n${failed} CHECKS FAILED (db: ${DB_PATH})`);
    process.exit(failed === 0 ? 0 : 1);
};

main().catch((err: any) => {
    console.error(err);
    process.exit(2);
});
