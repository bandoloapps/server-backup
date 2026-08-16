/**
 * Live-verify (B2.6): run the REAL compiled exporter against a COPY of the
 * real server.db, then assert the JSON structure with node (+ one jq check).
 *
 * Follows the verify_live_slice_a.ts pattern: mkdtemp + chmod 0600 + cleanup
 * in finally. The live server.db is NEVER touched — a private copy is made.
 *
 * Checks:
 *   - full run: exit 0, schemaVersion "1", mode "full", guildId from a
 *     minimal .env (GUILD_ID), users/channels maps, sessions with
 *     start/end/channelIds/timeline/topics
 *   - the real DB has NO users/channels cache tables -> unknown (<id>)
 *     fallback on every entry, never a crash or skip
 *   - empty/whitespace-only texts skipped (313 rows -> 263 emitted)
 *   - entries sorted by (time, messageId), no messageId duplicates
 *   - watermark.json = max emitted time
 *   - incremental re-run: sessions empty, exit 0, watermark unchanged
 *   - --from/--to bounded run: single session, filter reflected
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const SRC_DB = path.join(__dirname, "..", "..", "server.db");
const EXPORTER_JS = path.join(__dirname, "..", "export", "exportMessages.js");
const GUILD_ID = "771474521026330654";
const EXPECTED_TOTAL = 313;
const EXPECTED_EMITTED = 263; // 313 rows - 50 empty/whitespace texts

let failed = 0;
const check = (name: string, cond: boolean) => {
    if (!cond) { failed++; console.error(`FAIL: ${name}`); }
    else { console.log(`PASS: ${name}`); }
};

const iso = (ms: number) => new Date(ms).toISOString();

const runExporter = (cwd: string, args: string[]): { status: number; stdout: string } => {
    try {
        const stdout = execFileSync(process.execPath, [EXPORTER_JS, ...args], { cwd, encoding: "utf-8" });
        return { status: 0, stdout };
    } catch (err: any) {
        return { status: err.status ?? 1, stdout: (err.stdout ?? "") + (err.stderr ?? "") };
    }
};

const main = async () => {
    if (!fs.existsSync(SRC_DB)) { console.error("no server.db found"); process.exit(2); }
    if (!fs.existsSync(EXPORTER_JS)) { console.error("dist/export/exportMessages.js missing — run npm run build first"); process.exit(2); }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-b-live-"));
    try {
        // minimal .env: only GUILD_ID — tests the .env path without copying secrets
        fs.writeFileSync(path.join(tempDir, ".env"), `GUILD_ID = "${GUILD_ID}"\n`);
        fs.copyFileSync(SRC_DB, path.join(tempDir, "server.db"));
        fs.chmodSync(path.join(tempDir, "server.db"), 0o600);

        // ---- run 1: full export ----
        const r1 = runExporter(tempDir, ["--out", "export"]);
        check("full export exits 0", r1.status === 0);
        const outFile = path.join(tempDir, "export", "messages.json");
        check("messages.json written", fs.existsSync(outFile));
        const data = JSON.parse(fs.readFileSync(outFile, "utf-8"));

        check("schemaVersion is '1'", data.schemaVersion === "1");
        check("guildId read from .env GUILD_ID", data.guildId === GUILD_ID);
        check("mode is full", data.mode === "full");
        check("generatedAt is ISO-8601 UTC", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.generatedAt));
        check("filter defaults reflected", JSON.stringify(data.filter) === JSON.stringify({ channelIds: [], from: null, to: null }));
        check("users map is an object", typeof data.users === "object" && data.users !== null);
        check("channels map is an object", typeof data.channels === "object" && data.channels !== null);
        check("sessions is an array", Array.isArray(data.sessions) && data.sessions.length > 0);

        // every session: start/end ISO, channelIds array, timeline, topics
        let sessionsOk = true;
        const allEntries: any[] = [];
        for (const s of data.sessions) {
            sessionsOk &&= typeof s.start === "string" && /Z$/.test(s.start);
            sessionsOk &&= typeof s.end === "string" && /Z$/.test(s.end);
            sessionsOk &&= Array.isArray(s.channelIds) && Array.isArray(s.timeline) && Array.isArray(s.topics);
            for (const e of s.timeline) allEntries.push({ ...e, channelId: e.channelId });
            for (const t of s.topics) {
                sessionsOk &&= typeof t.id === "string" && typeof t.name === "string" && typeof t.channelId === "string" && Array.isArray(t.timeline);
                for (const e of t.timeline) allEntries.push(e);
            }
        }
        check("all sessions well-formed with ISO start/end", sessionsOk);

        // total emitted = 313 - 50 empty texts (real DB has no cache tables)
        check(`emitted count ${allEntries.length} == ${EXPECTED_EMITTED}`, allEntries.length === EXPECTED_EMITTED);

        // no cache tables -> unknown (<id>) fallback everywhere, no crash/skip
        const fallbackOk = allEntries.every((e: any) =>
            e.author === `unknown (${e.authorId})` && e.channel === `unknown (${e.channelId})`);
        check("unknown (<id>) fallback on every author/channel (no cache tables)", fallbackOk);

        // entry field contract
        const entryOk = allEntries.every((e: any) =>
            typeof e.id === "string" && typeof e.channelId === "string" && typeof e.authorId === "string" &&
            typeof e.author === "string" && typeof e.channel === "string" &&
            typeof e.time === "string" && /Z$/.test(e.time) && typeof e.text === "string");
        check("every entry has id/channelId/authorId/author/channel/time/text", entryOk);

        // no empty/whitespace text leaked
        check("no empty or whitespace-only text emitted", allEntries.every((e: any) => e.text.trim().length > 0));

        // chronological order (time, messageId)
        const sortedOk = allEntries.every((e: any, idx: number) => {
            if (idx === 0) return true;
            const prev = allEntries[idx - 1];
            return (prev.time > e.time) ? false : (prev.time < e.time ? true : prev.id <= e.id);
        });
        check("entries sorted by (time, messageId)", sortedOk);

        // dedupe
        const ids = allEntries.map((e: any) => e.id);
        check("no duplicate messageId", new Set(ids).size === ids.length);
        check(`no messageId exceeds total rows (${EXPECTED_TOTAL})`, ids.length <= EXPECTED_TOTAL);

        // watermark sidecar
        const wmFile = path.join(tempDir, "export", "watermark.json");
        check("watermark.json written", fs.existsSync(wmFile));
        const wm1 = JSON.parse(fs.readFileSync(wmFile, "utf-8"));
        const expectedMax = allEntries.reduce((m: number, e: any) => Math.max(m, new Date(e.time).getTime()), 0);
        check("watermark maxTime == max emitted time", wm1.maxTime === expectedMax);

        // ---- run 2: incremental — nothing newer than the watermark ----
        const r2 = runExporter(tempDir, ["--out", "export", "--incremental"]);
        check("incremental re-run exits 0", r2.status === 0);
        const data2 = JSON.parse(fs.readFileSync(outFile, "utf-8"));
        check("incremental with no new messages -> sessions empty", Array.isArray(data2.sessions) && data2.sessions.length === 0);
        check("incremental mode reflected", data2.mode === "incremental");
        const wm2 = JSON.parse(fs.readFileSync(wmFile, "utf-8"));
        check("watermark unchanged when no new messages", JSON.stringify(wm2) === JSON.stringify(wm1));

        // ---- run 3: bounded --from/--to -> single session ----
        const dayStart = new Date(1604163600000).toISOString(); // 2020-10-31 13:00:00Z
        const dayEnd = new Date(1604167200000).toISOString();
        const r3 = runExporter(tempDir, ["--out", "export", "--from", dayStart, "--to", dayEnd]);
        check("bounded run exits 0", r3.status === 0);
        const data3 = JSON.parse(fs.readFileSync(outFile, "utf-8"));
        check("--from/--to forces a single session", Array.isArray(data3.sessions) && data3.sessions.length === 1);
        check("filter.from/to reflected", data3.filter.from === dayStart && data3.filter.to === dayEnd);
        const inRange = data3.sessions[0].timeline.every((e: any) =>
            new Date(e.time).getTime() >= new Date(dayStart).getTime() && new Date(e.time).getTime() <= new Date(dayEnd).getTime());
        check("all emitted entries within the requested range", inRange && data3.sessions[0].timeline.length > 0);

        // ---- jq structural check (real CLI, not just node) ----
        try {
            const jqOut = execFileSync("jq", ["-r", ".schemaVersion", outFile], { encoding: "utf-8" }).trim();
            check("jq reads schemaVersion from messages.json", jqOut === "1");
        } catch {
            check("jq reads schemaVersion from messages.json", false);
        }

        console.log(failed === 0 ? "\nLIVE EXPORT CHECK PASSED" : `\n${failed} CHECKS FAILED`);
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    process.exit(failed === 0 ? 0 : 1);
};

main().catch((err: any) => { console.error(err); process.exit(2); });
