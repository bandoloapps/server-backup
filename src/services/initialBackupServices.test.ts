import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Sequelize } from "sequelize";
import { define_messages } from "../database/models/messages";

// ── T1 RED — cursor map: GROUP BY MAX(CAST(messageId AS INTEGER)) per channel ──
describe("T1 — cursor map GROUP BY MAX (numeric-safe)", () => {
    it("per-channel numeric MAX of string messageIds, exact 19-digit snowflakes preserved", async () => {
        const { build_cursor_map } = await import("./initialBackupIncremental");
        const sequelize = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
        const messages = define_messages(sequelize);
        await sequelize.sync({ force: true });
        try {
            await (messages as any).bulkCreate([
                { channelId: "c1", messageId: "2", userId: "u", time: 1, text: Buffer.from("a") },
                { channelId: "c1", messageId: "10", userId: "u", time: 1, text: Buffer.from("b") },
                { channelId: "c1", messageId: "5", userId: "u", time: 1, text: Buffer.from("c") },
                { channelId: "c2", messageId: "1298051389066317800", userId: "u", time: 1, text: Buffer.from("d") },
                { channelId: "c2", messageId: "1298051389066317851", userId: "u", time: 1, text: Buffer.from("e") },
            ]);
            const map = await build_cursor_map(messages);
            assert.equal(map.size, 2);
            // numeric, not lexicographic ("9" would beat "10")
            assert.equal(map.get("c1"), "10");
            // exact string — an imprecise JS number (sqlite3 INTEGER > 2^53) would round the tail
            assert.equal(map.get("c2"), "1298051389066317851");
        } finally {
            await sequelize.close();
        }
    });

    it("channel with a single message yields that id; channel with no rows absent", async () => {
        const { build_cursor_map } = await import("./initialBackupIncremental");
        const sequelize = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
        const messages = define_messages(sequelize);
        await sequelize.sync({ force: true });
        try {
            await (messages as any).bulkCreate([
                { channelId: "solo", messageId: "1787439796823", userId: "u", time: 1, text: Buffer.from("x") },
            ]);
            const map = await build_cursor_map(messages);
            assert.equal(map.get("solo"), "1787439796823");
            assert.equal(map.has("never-seen"), false);
        } finally {
            await sequelize.close();
        }
    });

    it("cursor_map_from_rows maps raw rows to strings, skips null maxId", async () => {
        const { cursor_map_from_rows } = await import("./initialBackupIncremental");
        const map = cursor_map_from_rows([
            { channelId: "a", maxId: 42 },
            { channelId: "b", maxId: null },
            { channelId: "c", maxId: "1787439796823" },
        ]);
        assert.equal(map.size, 2);
        assert.equal(map.get("a"), "42");
        assert.equal(map.get("c"), "1787439796823");
    });

    it("cursor_map_from_rows: all-null rows → empty map (skip logic ran)", async () => {
        const { cursor_map_from_rows } = await import("./initialBackupIncremental");
        const map = cursor_map_from_rows([
            { channelId: "x", maxId: null },
            { channelId: "y", maxId: undefined },
        ]);
        assert.equal(map.size, 0);
    });
});

// ── T2 RED — IGNORE_CHANNELS filter at the source (fresh seed + new-channel detection) ──
describe("T2 — IGNORE filter", () => {
    it("filter_ignored_channels excludes ignore_channels entries", async () => {
        const { filter_ignored_channels } = await import("./initialBackupIncremental");
        const channels = [{ id: "c1" }, { id: "dm-free-zone" }, { id: "c3" }];
        const out = filter_ignored_channels(channels, ["dm-free-zone"]);
        assert.deepEqual(out.map(c => c.id), ["c1", "c3"]);
    });

    it("empty ignore list keeps every channel", async () => {
        const { filter_ignored_channels } = await import("./initialBackupIncremental");
        const channels = [{ id: "a" }, { id: "b" }];
        assert.deepEqual(filter_ignored_channels(channels, []).map(c => c.id), ["a", "b"]);
    });

    it("all channels ignored → empty (filter actually ran)", async () => {
        const { filter_ignored_channels } = await import("./initialBackupIncremental");
        const channels = [{ id: "x" }, { id: "y" }];
        assert.deepEqual(filter_ignored_channels(channels, ["x", "y"]), []);
    });

    it("is_ignored true for listed channel, false otherwise", async () => {
        const { is_ignored } = await import("./initialBackupIncremental");
        assert.equal(is_ignored("dm-free-zone", ["dm-free-zone"]), true);
        assert.equal(is_ignored("c1", ["dm-free-zone"]), false);
    });
});

// ── T3 RED — forward paging via after: (ascending, stop <100, empty delta = 1 fetch) ──
describe("T3 — forward paging via after:", () => {
    it("empty delta costs exactly one fetch and completes", async () => {
        const { crawl_forward } = await import("./initialBackupIncremental");
        const fetchArgs: string[] = [];
        const fetch_page = async (after: string) => { fetchArgs.push(after); return [] as Array<{id: string}>; };
        const { fetches, last_after } = await crawl_forward(fetch_page, "1787439796823", async () => {}, async () => {});
        assert.equal(fetches, 1);
        assert.equal(last_after, "1787439796823");
        assert.deepEqual(fetchArgs, ["1787439796823"]);
    });

    it("pages ascending: after advances to the newest id; stops when a page has <100", async () => {
        const { crawl_forward } = await import("./initialBackupIncremental");
        const pages = [
            Array.from({ length: 100 }, (_, i) => ({ id: `m${1900 - i}` })), // newest-first: m1900 … m1801
            [{ id: "m1800" }, { id: "m1799" }],
        ];
        const fetchArgs: string[] = [];
        let call = 0;
        const fetch_page = async (after: string) => { fetchArgs.push(after); return pages[call++]; };
        const onPageNext: string[] = [];
        const seen: string[] = [];
        const { fetches, last_after } = await crawl_forward(
            fetch_page,
            "m1800",
            async (_page, next_after) => { onPageNext.push(next_after); },
            async (msg) => { seen.push(msg.id); }
        );
        assert.equal(fetches, 2);
        assert.deepEqual(fetchArgs, ["m1800", "m1900"]); // window ascends to newest fetched id
        assert.deepEqual(onPageNext, ["m1900", "m1800"]);
        assert.equal(seen.length, 102);
        assert.equal(seen[0], "m1900");
        assert.equal(last_after, "m1800");
    });

    it("backward/pending units are untouched: guards apply only to forward", async () => {
        const { is_forward_unit } = await import("./initialBackupIncremental");
        assert.equal(is_forward_unit({ direction: "forward" }), true);
        assert.equal(is_forward_unit({ direction: "backward" }), false);
        assert.equal(is_forward_unit({}), false); // fresh/pending/thread units keep legacy path
    });
});

// ── T3 RED — incremental enqueue decisions (R1/R4) ──
describe("T3 — incremental enqueue decisions", () => {
    it("complete + cursor → candidate; pending/in_progress/ignored/no-cursor excluded", async () => {
        const { incremental_candidates } = await import("./initialBackupIncremental");
        const checkpoints = [
            { channelId: "jogo-hoje", status: "complete" },
            { channelId: "pending-c", status: "pending" },
            { channelId: "inprog-c", status: "in_progress" },
            { channelId: "dm-free-zone", status: "complete" },
            { channelId: "no-msgs", status: "complete" },
        ];
        const cursorMap = new Map<string, string>([
            ["jogo-hoje", "1787439796823"],
            ["dm-free-zone", "5"],
        ]);
        const out = incremental_candidates(checkpoints, cursorMap, ["dm-free-zone"]);
        assert.deepEqual(out, [{ channelId: "jogo-hoje", after: "1787439796823" }]);
    });
});

// ── T4 RED — guards: forward units never in_progress, never channels_done++ (R2/R3) ──
describe("T4 — incremental guards", () => {
    it("forward unit: no in_progress write, no done count", async () => {
        const { unit_guards } = await import("./initialBackupIncremental");
        assert.deepEqual(unit_guards({ direction: "forward" }), { writeInProgress: false, countDone: false });
    });

    it("backward and direction-less units keep legacy in_progress + done behavior", async () => {
        const { unit_guards } = await import("./initialBackupIncremental");
        assert.deepEqual(unit_guards({ direction: "backward" }), { writeInProgress: true, countDone: true });
        assert.deepEqual(unit_guards({}), { writeInProgress: true, countDone: true });
    });

    it("crawl failure in forward mode propagates with zero per-page side effects (Missing Access keeps checkpoint complete)", async () => {
        const { crawl_forward } = await import("./initialBackupIncremental");
        let onPageCalls = 0;
        const fetch_page = async () => { throw new Error("Missing Access"); };
        await assert.rejects(
            crawl_forward(fetch_page as any, "x", async () => { onPageCalls++; }, async () => {}),
            /Missing Access/
        );
        assert.equal(onPageCalls, 0); // no page txn ran — nothing was persisted
    });
});

// ── T5 — integration scenarios (R1-R4) ──
describe("T5 — integration scenarios", () => {
    it("crash mid-crawl re-derives advanced MAX from messages and resumes forward (only newer fetched)", async () => {
        const { build_cursor_map, crawl_forward } = await import("./initialBackupIncremental");
        const sequelize = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
        const messages = define_messages(sequelize);
        await sequelize.sync({ force: true });
        try {
            await (messages as any).bulkCreate([
                { channelId: "c1", messageId: "100", userId: "u", time: 1, text: Buffer.from("a") },
                { channelId: "c1", messageId: "200", userId: "u", time: 1, text: Buffer.from("b") },
            ]);
            // restart: cursor re-derived from messages MAX (checkpoint stayed complete)
            const map = await build_cursor_map(messages);
            assert.equal(map.get("c1"), "200");
            const fetchArgs: string[] = [];
            const { fetches, last_after } = await crawl_forward(async (after) => {
                fetchArgs.push(after);
                return after === "200" ? [{ id: "300" }] : [];
            }, map.get("c1")!, async () => {}, async () => {});
            assert.equal(fetches, 1);
            assert.deepEqual(fetchArgs, ["200"]); // resumed from advanced MAX — skips already-saved
            assert.equal(last_after, "300");
        } finally {
            await sequelize.close();
        }
    });

    it("IGNORE respected at fresh seed, resume enqueue, and thread parent (R4)", async () => {
        const { filter_ignored_channels, incremental_candidates, is_ignored } = await import("./initialBackupIncremental");
        // fresh seed: fetch_channels filters ignore_channels at the source
        assert.deepEqual(filter_ignored_channels([{ id: "dm-free-zone" }, { id: "ok" }], ["dm-free-zone"]).map(c => c.id), ["ok"]);
        // resume enqueue: complete + ignored → no forward unit
        assert.deepEqual(
            incremental_candidates([{ channelId: "dm-free-zone", status: "complete" }], new Map([["dm-free-zone", "9"]]), ["dm-free-zone"]),
            []
        );
        // thread enqueue: parent channel ignored → thread never enqueued
        assert.equal(is_ignored("dm-free-zone", ["dm-free-zone"]), true);
    });

    it("counter invariant: forward catchup never moves channels_done (49/62 stays stable)", async () => {
        const { unit_guards, crawl_forward } = await import("./initialBackupIncremental");
        // forward units never count done (R3) — 49/62 before catchup stays 49/62 with zero new threads
        assert.deepEqual(unit_guards({ direction: "forward" }), { writeInProgress: false, countDone: false });
        // the only forward-side per-page write is the progress hook, which never touches done/total counts
        let onPageCalls = 0;
        await crawl_forward(async () => [{ id: "1" }], "0", async () => { onPageCalls++; }, async () => {});
        assert.equal(onPageCalls, 1);
    });
});