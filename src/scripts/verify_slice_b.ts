/**
 * Unit-style verification for Slice B (B1.1–B1.8): the offline JSON exporter.
 *
 * Written FIRST (RED): imports named functions from ../export/exportMessages,
 * which does not exist yet — `npm run build` fails until the module is
 * implemented (GREEN). The fork has no TS test framework, so this script IS
 * the test layer, mirroring verify_slice_a.ts.
 *
 * Covers (message-export spec + security spec + design D5–D8):
 *   - decrypt: raw-BLOB passthrough, encrypt->decrypt roundtrip, wrong-key
 *     error, invalid-UTF-8 missing-key error, empty blob
 *   - buildExport: schema shape, name resolution + unknown (<id>) fallback,
 *     empty/whitespace-text skip, ISO-8601 timestamps from epoch millis,
 *     (time, messageId) sort, messageId dedupe, channel filter, date-range
 *     filter, session gap splitting, --from/--to single session, threads as
 *     topics (never inline), thread parentId null, thread attachment,
 *     empty input, incremental strict-> watermark, watermark update rule
 *   - runExport on a scratch SQLite DB: real read path, messages.json +
 *     watermark.json written, missing users/channels tables -> empty cache,
 *     wrong password -> throws and writes no output
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import sqlite3 from "sqlite3";
import { execFileSync } from "child_process";
import { BLOB, INTEGER, Sequelize, STRING } from "sequelize";
import {
    decryptText,
    getKeyDerivationCount,
    resolveName,
    buildExport,
    readWatermark,
    runExport,
    parseArgs,
    ExportInput,
    ExportOptions,
} from "../export/exportMessages";

let failed = 0;
const check = (name: string, cond: boolean) => {
    if (!cond) { failed++; console.error(`FAIL: ${name}`); }
    else { console.log(`PASS: ${name}`); }
};

const encryptWith = (pw: string, data: Buffer): Buffer => {
    const key = crypto.scryptSync(pw, "salt", 32);
    const cipher = crypto.createCipheriv("aes256", key, Buffer.alloc(16, 0));
    return Buffer.concat([cipher.update(data), cipher.final()]);
};

const iso = (ms: number) => new Date(ms).toISOString();

const baseOptions = (over: Partial<ExportOptions> = {}): ExportOptions => ({
    guildId: "771474521026330654",
    channelIds: [],
    from: null,
    to: null,
    sessionGapMinutes: 60,
    incremental: false,
    watermark: null,
    password: undefined,
    ...over,
});

// ---------- Section 1: decryptText ----------

const test_decrypt = () => {
    console.log("\n== decryptText ==");

    // plaintext passthrough — no key configured
    const plain = decryptText(Buffer.from("hello world"), undefined);
    check("plaintext passthrough decodes stored UTF-8", plain === "hello world");

    // encrypted roundtrip — raw BLOB bytes, no hex decode
    const secret = "🧵 thread mention: <#123> — 日本語";
    const encrypted = encryptWith("pw123", Buffer.from(secret, "utf-8"));
    const decrypted = decryptText(encrypted, "pw123");
    check("encrypt->decrypt roundtrip preserves text", decrypted === secret);

    // triangulate: a second, different payload and password
    const secret2 = "second payload 2";
    const decrypted2 = decryptText(encryptWith("other-pw", Buffer.from(secret2)), "other-pw");
    check("second roundtrip with different key/payload", decrypted2 === secret2);

    // wrong password -> clear error (decipher.final BAD_DECRYPT path)
    let threw = false;
    try { decryptText(encrypted, "WRONG"); } catch (e: any) { threw = /password|decrypt/i.test(e.message); }
    check("wrong password throws clear decryption error", threw);

    // missing key on encrypted data -> invalid UTF-8 detected by fatal decoder
    let threw2 = false;
    try { decryptText(encrypted, undefined); } catch (e: any) { threw2 = /UTF-8|decrypt/i.test(e.message); }
    check("missing key on ciphertext throws clear error (fatal UTF-8)", threw2);

    // empty blob -> empty string (skipped upstream as empty text)
    check("empty blob decodes to empty string", decryptText(Buffer.alloc(0), undefined) === "");
    check("null blob decodes to empty string", decryptText(null, undefined) === "");
};

const test_key_derivation_cached = () => {
    console.log("\n== decryptText: scrypt key derivation is cached ==");
    const secret = "cache me if you can";
    const encrypted = encryptWith("cached-pw", Buffer.from(secret, "utf-8"));

    const before = getKeyDerivationCount();
    for (let i = 0; i < 10; i++) {
        const d = decryptText(encrypted, "cached-pw");
        check(`decrypt #${i + 1} succeeds`, d === secret);
    }
    const after = getKeyDerivationCount();
    check("same password derives key exactly once across many rows", after - before === 1);

    // a second password triggers exactly one more derivation
    decryptText(encryptWith("second-pw", Buffer.from("x")), "second-pw");
    check("second password triggers exactly one additional derivation", getKeyDerivationCount() - after === 1);
};

const expectParseError = (argv: string[], expected: RegExp): boolean => {
    try {
        parseArgs(argv);
        return false;
    } catch (e: any) {
        return expected.test(e.message);
    }
};

const test_parse_args = () => {
    console.log("\n== parseArgs contract ==");

    const defaults = parseArgs([]);
    check("defaults: no filters, outDir 'export', gap 60, incremental false",
        defaults.channelIds.length === 0 && defaults.from === null && defaults.to === null &&
        defaults.outDir === "export" && defaults.sessionGapMinutes === 60 && defaults.incremental === false);

    const parsed = parseArgs(["--password", "pw1", "--guild", "G1", "--channels", "c1,c2", "--from", "2024-01-01T00:00:00.000Z", "--to", "2024-02-01T00:00:00.000Z", "--session-gap-minutes", "90", "--incremental", "--out", "outdir"]);
    check("--password parsed", parsed.password === "pw1");
    check("--guild parsed", parsed.guildId === "G1");
    check("--channels parsed as list", JSON.stringify(parsed.channelIds) === JSON.stringify(["c1", "c2"]));
    check("--from parsed", parsed.from === "2024-01-01T00:00:00.000Z");
    check("--to parsed", parsed.to === "2024-02-01T00:00:00.000Z");
    check("--session-gap-minutes parsed", parsed.sessionGapMinutes === 90);
    check("--incremental parsed", parsed.incremental === true);
    check("--out parsed", parsed.outDir === "outdir");

    const inline = parseArgs(["--password=inline-pw", "--channels=c3", "--out=inline-out"]);
    check("inline --flag=value works", inline.password === "inline-pw" && inline.channelIds[0] === "c3" && inline.outDir === "inline-out");

    check("unknown option errors", expectParseError(["--bogus"], /unknown option/));
    check("--channels missing value errors", expectParseError(["--channels"], /missing value for --channels/));
    check("--password missing value errors", expectParseError(["--password"], /missing value for --password/));
    check("--guild missing value errors", expectParseError(["--guild"], /missing value for --guild/));
    check("--session-gap-minutes missing value errors", expectParseError(["--session-gap-minutes"], /missing value for --session-gap-minutes/));
    check("--from missing value errors", expectParseError(["--from"], /missing value for --from/));
    check("--to missing value errors", expectParseError(["--to"], /missing value for --to/));
    check("--out missing value errors", expectParseError(["--out"], /missing value for --out/));
    check("--out= empty errors", expectParseError(["--out="], /--out directory path cannot be empty/));
    check("invalid --session-gap-minutes errors", expectParseError(["--session-gap-minutes", "0"], /invalid --session-gap-minutes/));
};

// ---------- Section 2: resolveName ----------

const test_resolve_name = () => {
    console.log("\n== resolveName ==");
    const names = new Map([["u1", "alice"]]);
    check("known id resolves to name", resolveName("u1", names) === "alice");
    check("unknown id falls back to 'unknown (<id>)'", resolveName("u9", names) === "unknown (u9)");
};

// ---------- Section 3: buildExport (pure aggregation) ----------

const test_schema_shape = () => {
    console.log("\n== buildExport: schema shape ==");
    const input: ExportInput = {
        messages: [{ channelId: "c1", userId: "u1", messageId: "m1", time: 1700000000000, text: "hi" }],
        users: [{ userId: "u1", username: "alice", displayName: "Alice", globalName: null }],
        channels: [{ channelId: "c1", name: "general", type: "text", parentId: null }],
    };
    const { output } = buildExport(input, baseOptions());

    check("schemaVersion is '1'", output.schemaVersion === "1");
    check("guildId emitted", output.guildId === "771474521026330654");
    check("generatedAt is ISO-8601 UTC", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(output.generatedAt));
    check("mode defaults to full", output.mode === "full");
    check("filter reflects defaults", JSON.stringify(output.filter) === JSON.stringify({ channelIds: [], from: null, to: null }));
    check("users map shape", JSON.stringify(output.users) === JSON.stringify({ u1: { username: "alice", displayName: "Alice", globalName: null } }));
    check("channels map shape", JSON.stringify(output.channels) === JSON.stringify({ c1: { name: "general", type: "text", parentId: null } }));
    check("sessions is an array", Array.isArray(output.sessions));
    check("one session for one message", output.sessions.length === 1);
    const s0: any = output.sessions[0];
    check("session has start/end/channelIds/timeline/topics", typeof s0.start === "string" && typeof s0.end === "string" && Array.isArray(s0.channelIds) && Array.isArray(s0.timeline) && Array.isArray(s0.topics));
    check("session start/end are ISO", /Z$/.test(s0.start) && /Z$/.test(s0.end));
    check("session channelIds lists the channel", JSON.stringify(s0.channelIds) === JSON.stringify(["c1"]));
    const entry = s0.timeline[0];
    check("timeline entry has all seven fields",
        entry.id === "m1" && entry.channelId === "c1" && entry.authorId === "u1" &&
        entry.author === "Alice" && entry.channel === "general" &&
        entry.time === iso(1700000000000) && entry.text === "hi");
    check("time rendered as ISO, not raw millis", entry.time !== "1700000000000");
};

const test_name_fallback = () => {
    console.log("\n== buildExport: name resolution fallback ==");
    const input: ExportInput = {
        messages: [{ channelId: "cX", userId: "uX", messageId: "m1", time: 1700000000000, text: "still emitted" }],
        users: [],
        channels: [],
    };
    const { output } = buildExport(input, baseOptions());
    const entry: any = output.sessions[0].timeline[0];
    check("unknown author -> 'unknown (<id>)'", entry.author === "unknown (uX)");
    check("unknown channel -> 'unknown (<id>)'", entry.channel === "unknown (cX)");
    check("message with unknown names is still emitted", output.sessions[0].timeline.length === 1);
};

const test_empty_text_skip = () => {
    console.log("\n== buildExport: empty-text skip ==");
    const input: ExportInput = {
        messages: [
            { channelId: "c1", userId: "u1", messageId: "m-empty", time: 100, text: "" },
            { channelId: "c1", userId: "u1", messageId: "m-ws", time: 200, text: "   \t " },
            { channelId: "c1", userId: "u1", messageId: "m-keep", time: 300, text: "real" },
        ],
        users: [], channels: [],
    };
    const { output, emittedCount } = buildExport(input, baseOptions());
    const timeline: any[] = output.sessions[0].timeline;
    check("empty and whitespace-only texts skipped", timeline.length === 1);
    check("kept message is the non-empty one", timeline[0].id === "m-keep" && timeline[0].text === "real");
    check("emittedCount counts only emitted", emittedCount === 1);
};

const test_timestamps = () => {
    console.log("\n== buildExport: timestamp rendering ==");
    const input: ExportInput = {
        messages: [{ channelId: "c1", userId: "u1", messageId: "m1", time: 1700000000000, text: "x" }],
        users: [], channels: [],
    };
    const { output } = buildExport(input, baseOptions());
    const entry: any = output.sessions[0].timeline[0];
    check("epoch millis 1700000000000 renders as ISO-8601 UTC", entry.time === "2023-11-14T22:13:20.000Z");
};

const test_sort_and_dedupe = () => {
    console.log("\n== buildExport: sort + dedupe ==");
    const input: ExportInput = {
        messages: [
            { channelId: "c1", userId: "u1", messageId: "m-b", time: 500, text: "b" },
            { channelId: "c1", userId: "u1", messageId: "m-a", time: 500, text: "a" },   // equal time -> sort by id
            { channelId: "c1", userId: "u1", messageId: "m-b", time: 500, text: "dup" }, // duplicate id
            { channelId: "c1", userId: "u1", messageId: "m-0", time: 100, text: "first" },
        ],
        users: [], channels: [],
    };
    const { output, emittedCount } = buildExport(input, baseOptions());
    const ids = output.sessions[0].timeline.map((e: any) => e.id);
    check("sorted by (time, messageId) ascending", JSON.stringify(ids) === JSON.stringify(["m-0", "m-a", "m-b"]));
    check("deduped by messageId", new Set(ids).size === ids.length);
    check("emittedCount excludes the duplicate", emittedCount === 3);
};

const test_channel_filter = () => {
    console.log("\n== buildExport: channel filter ==");
    const input: ExportInput = {
        messages: [
            { channelId: "c1", userId: "u1", messageId: "m1", time: 100, text: "one" },
            { channelId: "c2", userId: "u2", messageId: "m2", time: 200, text: "two" },
            { channelId: "c3", userId: "u3", messageId: "m3", time: 300, text: "three" },
        ],
        users: [], channels: [],
    };
    const { output, emittedCount } = buildExport(input, baseOptions({ channelIds: ["c1", "c3"] }));
    const ids = output.sessions[0].timeline.map((e: any) => e.id);
    check("only listed channels emitted", JSON.stringify(ids) === JSON.stringify(["m1", "m3"]));
    check("filter.channelIds reflects the applied list", JSON.stringify(output.filter.channelIds) === JSON.stringify(["c1", "c3"]));
    check("emittedCount respects the channel filter", emittedCount === 2);
};

const test_date_range_filter = () => {
    console.log("\n== buildExport: date-range filter ==");
    const from = "2024-01-01T00:00:00.000Z";
    const to = "2024-01-02T00:00:00.000Z";
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    const input: ExportInput = {
        messages: [
            { channelId: "c1", userId: "u1", messageId: "m-before", time: fromMs - 60000, text: "before" },
            { channelId: "c1", userId: "u1", messageId: "m-inside", time: fromMs + 60000, text: "inside" },
            { channelId: "c1", userId: "u1", messageId: "m-edge", time: toMs, text: "edge" },
            { channelId: "c1", userId: "u1", messageId: "m-after", time: toMs + 60000, text: "after" },
        ],
        users: [], channels: [],
    };
    const { output, emittedCount } = buildExport(input, baseOptions({ from, to }));
    const ids = output.sessions[0].timeline.map((e: any) => e.id);
    check("only messages within the range emitted (inclusive bounds)", JSON.stringify(ids) === JSON.stringify(["m-inside", "m-edge"]));
    check("filter.from reflects the argument", output.filter.from === from);
    check("filter.to reflects the argument", output.filter.to === to);
    check("emittedCount respects the range", emittedCount === 2);
};

const test_session_grouping = () => {
    console.log("\n== buildExport: session grouping ==");
    const burst1 = [1000, 2000];
    const burst2 = [72000000, 72100000]; // gap from burst1 > 60min
    const mk = (id: string, t: number) => ({ channelId: "c1", userId: "u1", messageId: id, time: t, text: id });
    const input: ExportInput = {
        messages: [...burst1.map((t, i) => mk(`a${i}`, t)), ...burst2.map((t, i) => mk(`b${i}`, t))],
        users: [], channels: [],
    };

    const gap = buildExport(input, baseOptions());
    check("idle gap > 60min splits into two sessions", gap.output.sessions.length === 2);
    const s1: any = gap.output.sessions[0];
    const s2: any = gap.output.sessions[1];
    check("session 1 start/end from its own burst", s1.start === iso(1000) && s1.end === iso(2000));
    check("session 2 start/end from its own burst", s2.start === iso(72000000) && s2.end === iso(72100000));
    check("session 1 timeline only burst 1", JSON.stringify(s1.timeline.map((e: any) => e.id)) === JSON.stringify(["a0", "a1"]));

    // triangulate: gap below the threshold -> single session
    const close = buildExport({
        messages: [mk("x0", 1000), mk("x1", 1000 + 30 * 60000)],
        users: [], channels: [],
    }, baseOptions());
    check("gap below threshold stays one session", close.output.sessions.length === 1);

    // triangulate: custom --session-gap-minutes raises the threshold
    const wide = buildExport({
        messages: [mk("x0", 1000), mk("x1", 1000 + 61 * 60000)],
        users: [], channels: [],
    }, baseOptions({ sessionGapMinutes: 90 }));
    check("sessionGapMinutes=90 keeps a 61-min gap in one session", wide.output.sessions.length === 1);
};

const test_single_session_range = () => {
    console.log("\n== buildExport: --from/--to forces a single session ==");
    const mk = (id: string, t: number) => ({ channelId: "c1", userId: "u1", messageId: id, time: t, text: id });
    const input: ExportInput = {
        messages: [mk("a0", 1000), mk("a1", 2000), mk("b0", 72000000), mk("b1", 72100000)],
        users: [], channels: [],
    };
    const { output } = buildExport(input, baseOptions({ from: "1970-01-01T00:00:00.000Z", to: "1971-01-01T00:00:00.000Z" }));
    check("range filter yields exactly one session", output.sessions.length === 1);
    const s0: any = output.sessions[0];
    check("single session spans the whole range", s0.timeline.length === 4 && s0.start === iso(1000) && s0.end === iso(72100000));
};

const test_threads_as_topics = () => {
    console.log("\n== buildExport: threads as separate topics ==");
    const mkText = (id: string, t: number) => ({ channelId: "c1", userId: "u1", messageId: id, time: t, text: id });
    const mkThread = (id: string, cid: string, t: number) => ({ channelId: cid, userId: "u2", messageId: id, time: t, text: id });
    const input: ExportInput = {
        messages: [
            mkText("main1", 1000),
            mkText("main2", 2000),
            mkThread("t1a", "THREAD1", 1500),
            mkThread("t1b", "THREAD1", 1600),
            mkThread("t2a", "THREAD2", 3000), // in the gap -> nearest-preceding session
            mkText("main3", 72000000),
        ],
        users: [{ userId: "u2", username: "bob", displayName: "Bob", globalName: null }],
        channels: [
            { channelId: "c1", name: "general", type: "text", parentId: null },
            { channelId: "THREAD1", name: "announcement-thread", type: "thread", parentId: "c1" },
            { channelId: "THREAD2", name: "orphan-thread", type: "thread", parentId: null },
        ],
    };
    const { output } = buildExport(input, baseOptions());
    const s1: any = output.sessions[0];
    const s2: any = output.sessions[1];

    check("thread messages never inline in timeline", !s1.timeline.some((e: any) => e.channelId === "THREAD1") && !s1.timeline.some((e: any) => e.channelId === "THREAD2"));
    check("two sessions from the text timeline", output.sessions.length === 2);
    check("session 1 hosts both topics", s1.topics.length === 2);
    check("session 2 has no topics", s2.topics.length === 0);

    const t1 = s1.topics.find((t: any) => t.channelId === "THREAD1");
    const t2 = s1.topics.find((t: any) => t.channelId === "THREAD2");
    check("topic 1 has id/name/channelId/timeline", t1 && t1.id === "THREAD1" && t1.name === "announcement-thread" && t1.channelId === "THREAD1" && t1.timeline.length === 2);
    check("topic 1 entries resolved", t1.timeline[0].author === "Bob" && t1.timeline[0].channel === "announcement-thread");
    check("topic 2 (no parent) name resolves with parentId null in map", t2 && t2.name === "orphan-thread" && output.channels["THREAD2"].parentId === null);
    check("topics sorted by first-message time", s1.topics[0].channelId === "THREAD1");
};

const test_incremental = () => {
    console.log("\n== buildExport: incremental watermark ==");
    const mk = (id: string, t: number) => ({ channelId: "c1", userId: "u1", messageId: id, time: t, text: id });
    const input: ExportInput = {
        messages: [
            mk("m-old", 1699999999999),
            mk("m-eq", 1700000000000),
            mk("m-new", 1700000000001),
        ],
        users: [], channels: [],
    };
    const { output, maxTime, emittedCount } = buildExport(input, baseOptions({ incremental: true, watermark: 1700000000000 }));
    check("mode is incremental", output.mode === "incremental");
    check("strict > watermark: only newer messages emitted", JSON.stringify(output.sessions[0].timeline.map((e: any) => e.id)) === JSON.stringify(["m-new"]));
    check("maxTime equals max emitted time", maxTime === 1700000000001);
    check("emittedCount is the delta count", emittedCount === 1);

    // no new messages -> empty sessions, maxTime null (watermark unchanged)
    const stale = buildExport(input, baseOptions({ incremental: true, watermark: 1700000000001 }));
    check("no new messages -> sessions empty", stale.output.sessions.length === 0);
    check("no new messages -> maxTime null (watermark unchanged)", stale.maxTime === null);
    check("no new messages -> emittedCount 0", stale.emittedCount === 0);

    // regression: a watermark sidecar must NOT filter a FULL export
    const fullWithWatermark = buildExport(input, baseOptions({ incremental: false, watermark: 1700000000001 }));
    check("full mode ignores an existing watermark", fullWithWatermark.emittedCount === 3 && fullWithWatermark.maxTime === 1700000000001);
};

const test_empty_db = () => {
    console.log("\n== buildExport: empty database ==");
    const { output, maxTime, emittedCount } = buildExport({ messages: [], users: [], channels: [] }, baseOptions());
    check("empty input -> sessions []", JSON.stringify(output.sessions) === "[]");
    check("empty input -> maxTime null", maxTime === null);
    check("empty input -> emittedCount 0", emittedCount === 0);
};

// ---------- Section 4: runExport on a scratch SQLite DB ----------

const test_run_export_scratch_db = async () => {
    console.log("\n== runExport: scratch SQLite DB ==");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-unit-"));
    const dbPath = path.join(tempDir, "server.db");
    let sequelize: Sequelize | null = null;
    try {
        sequelize = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const models = await await_define(sequelize);
        const { messages, users, channels } = models;

        // fixtures: all encrypted with pw1 (a DB is all-plaintext or
        // all-encrypted, never mixed), plus an empty-text message to skip
        await messages.bulkCreate([
            { channelId: "c1", userId: "u1", messageId: "m1", time: 1000, text: encryptWith("pw1", Buffer.from("plain hello", "utf-8")) },
            { channelId: "c1", userId: "u1", messageId: "m2", time: 2000, text: encryptWith("pw1", Buffer.from("secret hello", "utf-8")) },
            { channelId: "THREAD1", userId: "u2", messageId: "t1", time: 1500, text: encryptWith("pw1", Buffer.from("thread msg", "utf-8")) },
            { channelId: "c1", userId: "u1", messageId: "m-empty", time: 3000, text: Buffer.alloc(0) },
        ]);
        await users.bulkCreate([
            { userId: "u1", username: "alice", displayName: "Alice", globalName: null },
            { userId: "u2", username: "bob", displayName: "Bob", globalName: "Bobby" },
        ]);
        await channels.bulkCreate([
            { channelId: "c1", name: "general", type: "text", parentId: null },
            { channelId: "THREAD1", name: "topic-x", type: "thread", parentId: "c1" },
        ]);
        await sequelize.close();
        sequelize = null;

        const reader = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const outDir = path.join(tempDir, "export");
        const result = await runExport(reader, baseOptions({ password: "pw1" }), outDir);
        await reader.close();

        check("runExport emitted 3 messages (empty skipped)", result.emittedCount === 3);
        check("messages.json written", fs.existsSync(path.join(outDir, "messages.json")));
        const parsed = JSON.parse(fs.readFileSync(path.join(outDir, "messages.json"), "utf-8"));
        check("messages.json schemaVersion 1", parsed.schemaVersion === "1");
        check("users map carries globalName", parsed.users.u2.globalName === "Bobby");
        check("decrypted text in output", parsed.sessions[0].timeline.some((e: any) => e.id === "m2" && e.text === "secret hello"));
        check("thread emitted as topic, not inline", parsed.sessions[0].topics[0].channelId === "THREAD1" && parsed.sessions[0].topics[0].name === "topic-x");
        check("empty text message absent", !JSON.stringify(parsed).includes("m-empty"));
        check("watermark.json written with max emitted time", JSON.parse(fs.readFileSync(path.join(outDir, "watermark.json"), "utf-8")).maxTime === 2000);
    } finally {
        if (sequelize) { try { await sequelize.close(); } catch {} }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
};

const await_define = async (sequelize: Sequelize) => {
    // inline definitions mirroring the exporter's read-only models
    const messages = sequelize.define("messages", {
        channelId: { type: STRING }, userId: { type: STRING },
        messageId: { type: STRING }, time: { type: INTEGER },
        text: { type: BLOB },
    }, { timestamps: false, freezeTableName: true });
    const users = sequelize.define("users", {
        userId: { type: STRING, primaryKey: true },
        username: { type: STRING }, displayName: { type: STRING },
        globalName: { type: STRING },
    }, { timestamps: false, freezeTableName: true });
    const channels = sequelize.define("channels", {
        channelId: { type: STRING, primaryKey: true },
        name: { type: STRING }, type: { type: STRING },
        parentId: { type: STRING },
    }, { timestamps: false, freezeTableName: true });
    await sequelize.sync();
    return { messages, users, channels };
};

const test_no_cache_tables = async () => {
    console.log("\n== runExport: missing users/channels tables -> empty cache ==");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-nocache-"));
    const dbPath = path.join(tempDir, "server.db");
    let sequelize: Sequelize | null = null;
    try {
        sequelize = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const messages = sequelize.define("messages", {
            channelId: { type: STRING }, userId: { type: STRING },
            messageId: { type: STRING }, time: { type: INTEGER },
            text: { type: BLOB },
        }, { timestamps: false, freezeTableName: true });
        await sequelize.sync();
        await messages.bulkCreate([{ channelId: "c1", userId: "u1", messageId: "m1", time: 1000, text: Buffer.from("hi") }]);
        await sequelize.close();
        sequelize = null;

        const reader = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const outDir = path.join(tempDir, "export");
        const result = await runExport(reader, baseOptions(), outDir);
        await reader.close();

        check("export still runs with no cache tables", result.emittedCount === 1);
        const parsed = JSON.parse(fs.readFileSync(path.join(outDir, "messages.json"), "utf-8"));
        check("users/channels maps empty", JSON.stringify(parsed.users) === "{}" && JSON.stringify(parsed.channels) === "{}");
        check("names fall back to unknown (<id>)", parsed.sessions[0].timeline[0].author === "unknown (u1)" && parsed.sessions[0].timeline[0].channel === "unknown (c1)");
    } finally {
        if (sequelize) { try { await sequelize.close(); } catch {} }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
};

const test_wrong_password_writes_nothing = async () => {
    console.log("\n== runExport: wrong password writes no output ==");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-badpw-"));
    const dbPath = path.join(tempDir, "server.db");
    let sequelize: Sequelize | null = null;
    try {
        sequelize = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const messages = sequelize.define("messages", {
            channelId: { type: STRING }, userId: { type: STRING },
            messageId: { type: STRING }, time: { type: INTEGER },
            text: { type: BLOB },
        }, { timestamps: false, freezeTableName: true });
        await sequelize.sync();
        await messages.bulkCreate([{ channelId: "c1", userId: "u1", messageId: "m1", time: 1000, text: encryptWith("right", Buffer.from("secret")) }]);
        await sequelize.close();
        sequelize = null;

        const reader = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const outDir = path.join(tempDir, "export");
        let threw = false;
        try { await runExport(reader, baseOptions({ password: "wrong" }), outDir); } catch (e: any) { threw = /decrypt/i.test(e.message); }
        await reader.close();

        check("wrong password throws", threw);
        check("messages.json not written on decrypt failure", !fs.existsSync(path.join(outDir, "messages.json")));
        check("watermark.json not written on decrypt failure", !fs.existsSync(path.join(outDir, "watermark.json")));
    } finally {
        if (sequelize) { try { await sequelize.close(); } catch {} }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
};

const test_atomic_writes = async () => {
    console.log("\n== runExport: atomic writes leave no temp files ==");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-atomic-"));
    const dbPath = path.join(tempDir, "server.db");
    let sequelize: Sequelize | null = null;
    try {
        sequelize = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const messages = sequelize.define("messages", {
            channelId: { type: STRING }, userId: { type: STRING },
            messageId: { type: STRING }, time: { type: INTEGER },
            text: { type: BLOB },
        }, { timestamps: false, freezeTableName: true });
        await sequelize.sync();
        await messages.bulkCreate([{ channelId: "c1", userId: "u1", messageId: "m1", time: 1000, text: Buffer.from("hi") }]);
        await sequelize.close();
        sequelize = null;

        const reader = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const outDir = path.join(tempDir, "export");
        await runExport(reader, baseOptions(), outDir);
        await reader.close();

        check("messages.json committed", fs.existsSync(path.join(outDir, "messages.json")));
        check("watermark.json committed", fs.existsSync(path.join(outDir, "watermark.json")));
        const leftovers = fs.readdirSync(outDir).filter((f) => f.startsWith(".tmp-"));
        check("no .tmp-* files left in output directory", leftovers.length === 0);
    } finally {
        if (sequelize) { try { await sequelize.close(); } catch {} }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
};

const test_read_watermark = () => {
    console.log("\n== readWatermark ==");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-wm-"));
    try {
        check("missing watermark file -> null", readWatermark(tempDir) === null);
        fs.writeFileSync(path.join(tempDir, "watermark.json"), JSON.stringify({ maxTime: 123456789 }));
        check("existing watermark parsed", readWatermark(tempDir) === 123456789);
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
};

const test_incremental_filter_rejected = async () => {
    console.log("\n== runExport: incremental + filter rejected ==");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-inc-filter-"));
    const dbPath = path.join(tempDir, "server.db");
    let sequelize: Sequelize | null = null;
    try {
        sequelize = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const messages = sequelize.define("messages", {
            channelId: { type: STRING }, userId: { type: STRING },
            messageId: { type: STRING }, time: { type: INTEGER },
            text: { type: BLOB },
        }, { timestamps: false, freezeTableName: true });
        await sequelize.sync();
        await messages.bulkCreate([{ channelId: "c1", userId: "u1", messageId: "m1", time: 1000, text: Buffer.from("hi") }]);
        await sequelize.close();
        sequelize = null;

        const reader = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const outDir = path.join(tempDir, "export");
        let threw = false;
        try {
            await runExport(reader, baseOptions({ incremental: true, channelIds: ["c1"], watermark: 0 }), outDir);
        } catch (e: any) {
            threw = /incremental cannot be combined/i.test(e.message);
        }
        await reader.close();

        check("incremental + --channels throws before any write", threw);
        check("messages.json not written on incremental+filter rejection", !fs.existsSync(path.join(outDir, "messages.json")));
        check("watermark.json not written on incremental+filter rejection", !fs.existsSync(path.join(outDir, "watermark.json")));
    } finally {
        if (sequelize) { try { await sequelize.close(); } catch {} }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
};

const test_watermark_never_lowered = async () => {
    console.log("\n== runExport: watermark never lowered ==");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-wm-lower-"));
    const dbPath = path.join(tempDir, "server.db");
    let sequelize: Sequelize | null = null;
    try {
        sequelize = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const messages = sequelize.define("messages", {
            channelId: { type: STRING }, userId: { type: STRING },
            messageId: { type: STRING }, time: { type: INTEGER },
            text: { type: BLOB },
        }, { timestamps: false, freezeTableName: true });
        await sequelize.sync();
        await messages.bulkCreate([
            { channelId: "c1", userId: "u1", messageId: "m1", time: 1000, text: Buffer.from("older") },
        ]);
        await sequelize.close();
        sequelize = null;

        const reader = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const outDir = path.join(tempDir, "export");
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "watermark.json"), JSON.stringify({ maxTime: 9999 }));
        let threw = false;
        try {
            await runExport(reader, baseOptions(), outDir);
        } catch (e: any) {
            threw = /watermark regression rejected/i.test(e.message);
        }
        await reader.close();

        const wm = JSON.parse(fs.readFileSync(path.join(outDir, "watermark.json"), "utf-8"));
        check("full export with lower maxTime throws watermark regression error", threw);
        check("existing watermark is preserved", wm.maxTime === 9999);
        check("messages.json not written when watermark regressed", !fs.existsSync(path.join(outDir, "messages.json")));
    } finally {
        if (sequelize) { try { await sequelize.close(); } catch {} }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
};

const test_readonly_open_missing_db = async () => {
    console.log("\n== exporter: OPEN_READONLY refuses to create missing DB ==");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-ro-"));
    const missingDb = path.join(tempDir, "does-not-exist.db");
    const ro = new Sequelize({
        dialect: "sqlite",
        storage: missingDb,
        logging: false,
        dialectOptions: { mode: sqlite3.OPEN_READONLY },
    });
    let threw = false;
    let code: string | undefined;
    try {
        await ro.authenticate();
    } catch (e: any) {
        threw = true;
        code = e.original?.code ?? e.code;
        // closing a connection that never opened can hang; leave it for GC
    }
    check("OPEN_READONLY on missing file throws", threw);
    check("error code is SQLITE_CANTOPEN", code === "SQLITE_CANTOPEN");
    check("missing DB was not created", !fs.existsSync(missingDb));
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
};

const test_entry_guard_symlink = async () => {
    console.log("\n== CLI entry guard resolves symlinks ==");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-symlink-"));
    const dbPath = path.join(tempDir, "server.db");
    let sequelize: Sequelize | null = null;
    try {
        sequelize = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
        const messages = sequelize.define("messages", {
            channelId: { type: STRING }, userId: { type: STRING },
            messageId: { type: STRING }, time: { type: INTEGER },
            text: { type: BLOB },
        }, { timestamps: false, freezeTableName: true });
        await sequelize.sync();
        await messages.bulkCreate([{ channelId: "c1", userId: "u1", messageId: "m1", time: 1000, text: Buffer.from("hi") }]);
        await sequelize.close();
        sequelize = null;

        const realExporter = path.join(__dirname, "..", "export", "exportMessages.js");
        const symlinkExporter = path.join(tempDir, "exporter-symlink.js");
        fs.symlinkSync(realExporter, symlinkExporter);

        const outDir = path.join(tempDir, "export");
        const stdout = execFileSync(process.execPath, [symlinkExporter, "--out", outDir], { cwd: tempDir, encoding: "utf-8" });
        check("exporter runs when invoked through a symlink", /exported 1 message/i.test(stdout));
        check("messages.json produced via symlink", fs.existsSync(path.join(outDir, "messages.json")));
    } finally {
        if (sequelize) { try { await sequelize.close(); } catch {} }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
};

// ---------- run ----------

const main = async () => {
    test_decrypt();
    test_key_derivation_cached();
    test_parse_args();
    test_resolve_name();
    test_schema_shape();
    test_name_fallback();
    test_empty_text_skip();
    test_timestamps();
    test_sort_and_dedupe();
    test_channel_filter();
    test_date_range_filter();
    test_session_grouping();
    test_single_session_range();
    test_threads_as_topics();
    test_incremental();
    test_empty_db();
    await test_run_export_scratch_db();
    await test_no_cache_tables();
    await test_wrong_password_writes_nothing();
    await test_atomic_writes();
    test_read_watermark();
    await test_incremental_filter_rejected();
    await test_watermark_never_lowered();
    await test_readonly_open_missing_db();
    await test_entry_guard_symlink();

    console.log(failed === 0 ? "\nVERIFY SLICE B: ALL PASS" : `\nVERIFY SLICE B: ${failed} CHECKS FAILED`);
    process.exit(failed === 0 ? 0 : 1);
};

main().catch((err: any) => { console.error(err); process.exit(2); });
