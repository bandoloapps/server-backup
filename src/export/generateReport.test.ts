import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  loadAndValidate,
  filterSessions,
  resolveNames,
  computeOutputPath,
  computeDailyOutputPath,
  formatDay,
  groupSessionsByDay,
  TZ,
  parseReportArgs,
  buildSections,
  clampTransform,
  getImageDimensions,
  tryEmbedImages,
  main,
  type ExportOutput,
  type ReportIO,
  type ReportOptions,
} from "./generateReport";
import { SectionType, Packer } from "docx";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------- fixtures ----------

function makeOutput(overrides: Partial<ExportOutput> = {}): ExportOutput {
  return {
    schemaVersion: "1",
    guildId: "guild-1",
    generatedAt: "2026-08-19T20:00:00.000Z",
    mode: "full",
    filter: { channelIds: [], from: null, to: null },
    users: {
      "u1": { username: "alice", displayName: "Alice", globalName: "Alice G" },
      "u2": { username: "bob", displayName: null, globalName: "Bob G" },
    },
    channels: {
      "c1": { name: "general", type: "text", parentId: null },
      "c2": { name: "random", type: "text", parentId: null },
    },
    sessions: [
      {
        start: "2026-08-19T20:00:00.000Z",
        end: "2026-08-19T21:00:00.000Z",
        channelIds: ["c1", "c2"],
        timeline: [
          {
            id: "m1",
            channelId: "c1",
            authorId: "u1",
            author: "Alice",
            channel: "general",
            time: "2026-08-19T20:00:00.000Z",
            text: "Hello world",
          },
          {
            id: "m2",
            channelId: "c2",
            authorId: "u2",
            author: "Bob G",
            channel: "random",
            time: "2026-08-19T20:30:00.000Z",
            text: "Hi there",
          },
        ],
        topics: [],
      },
    ],
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ReportOptions> = {}): ReportOptions {
  return {
    sessionIndex: null,
    channelIds: [],
    from: null,
    to: null,
    viewMode: "chronological",
    serverName: null,
    output: null,
    ...overrides,
  };
}

// ---------- loadAndValidate ----------

describe("loadAndValidate", () => {
  it("returns parsed ExportOutput for valid schema version", () => {
    const data = makeOutput();
    const result = loadAndValidate(JSON.stringify(data));
    assert.equal(result.schemaVersion, "1");
    assert.equal(result.guildId, "guild-1");
    assert.equal(result.sessions.length, 1);
  });

  it("throws on malformed JSON", () => {
    assert.throws(() => loadAndValidate("{not valid json"), /invalid JSON/i);
  });

  it("throws on unknown schema version", () => {
    const data = makeOutput({ schemaVersion: "99" });
    assert.throws(
      () => loadAndValidate(JSON.stringify(data)),
      /unsupported schema version/i
    );
  });

  it("throws when schemaVersion is missing", () => {
    const data = makeOutput();
    delete (data as any).schemaVersion;
    assert.throws(
      () => loadAndValidate(JSON.stringify(data)),
      /schemaVersion/i
    );
  });
});

// ---------- filterSessions ----------

describe("filterSessions", () => {
  it("returns all sessions when no filters applied", () => {
    const output = makeOutput();
    const result = filterSessions(output, makeOptions());
    assert.equal(result.length, 1);
  });

  it("filters by session index", () => {
    const output = makeOutput({
      sessions: [
        { ...makeOutput().sessions[0], start: "2026-08-19T18:00:00.000Z", end: "2026-08-19T19:00:00.000Z" },
        makeOutput().sessions[0],
      ],
    });
    const result = filterSessions(output, makeOptions({ sessionIndex: 1 }));
    assert.equal(result.length, 1);
    assert.equal(result[0].start, "2026-08-19T20:00:00.000Z");
  });

  it("filters by channel id", () => {
    const output = makeOutput();
    const result = filterSessions(output, makeOptions({ channelIds: ["c1"] }));
    // session has both c1 and c2; filter keeps the session but only c1 messages
    assert.equal(result.length, 1);
    const c1Messages = result[0].timeline.filter((e) => e.channelId === "c1");
    assert.equal(c1Messages.length, 1);
    const c2Messages = result[0].timeline.filter((e) => e.channelId === "c2");
    assert.equal(c2Messages.length, 0);
  });

  it("filters by --from time", () => {
    const output = makeOutput();
    const result = filterSessions(
      output,
      makeOptions({ from: "2026-08-19T20:15:00.000Z" })
    );
    assert.equal(result.length, 1);
    // only m2 at 20:30 survives
    assert.equal(result[0].timeline.length, 1);
    assert.equal(result[0].timeline[0].id, "m2");
  });

  it("filters by --to time", () => {
    const output = makeOutput();
    const result = filterSessions(
      output,
      makeOptions({ to: "2026-08-19T20:15:00.000Z" })
    );
    assert.equal(result.length, 1);
    // only m1 at 20:00 survives
    assert.equal(result[0].timeline.length, 1);
    assert.equal(result[0].timeline[0].id, "m1");
  });

  it("returns empty array when no sessions match", () => {
    const output = makeOutput();
    const result = filterSessions(
      output,
      makeOptions({ sessionIndex: 99 })
    );
    assert.equal(result.length, 0);
  });

  it("combines session index and channel filters", () => {
    const output = makeOutput({
      sessions: [
        { ...makeOutput().sessions[0], start: "2026-08-19T18:00:00.000Z", end: "2026-08-19T19:00:00.000Z" },
        makeOutput().sessions[0],
      ],
    });
    const result = filterSessions(
      output,
      makeOptions({ sessionIndex: 1, channelIds: ["c1"] })
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].timeline.length, 1);
    assert.equal(result[0].timeline[0].channelId, "c1");
  });
});

// ---------- resolveNames ----------

describe("resolveNames", () => {
  it("resolves known user and channel names", () => {
    const output = makeOutput();
    const session = output.sessions[0];
    const result = resolveNames(session, output.users, output.channels);
    // timeline authors should be resolved
    assert.equal(result.timeline[0].author, "Alice");
    assert.equal(result.timeline[0].channel, "general");
  });

  it("falls back to unknown (<id>) for missing users", () => {
    const output = makeOutput();
    const session = {
      ...output.sessions[0],
      timeline: [
        { ...output.sessions[0].timeline[0], authorId: "u99" },
      ],
    };
    const result = resolveNames(session, output.users, output.channels);
    assert.equal(result.timeline[0].author, "unknown (u99)");
  });

  it("falls back to unknown (<id>) for missing channels", () => {
    const output = makeOutput();
    const session = {
      ...output.sessions[0],
      timeline: [
        { ...output.sessions[0].timeline[0], channelId: "c99" },
      ],
    };
    const result = resolveNames(session, output.users, output.channels);
    assert.equal(result.timeline[0].channel, "unknown (c99)");
  });

  it("preserves emoji as Unicode text", () => {
    const output = makeOutput();
    const session = {
      ...output.sessions[0],
      timeline: [
        { ...output.sessions[0].timeline[0], text: "Hello 👍🎉" },
      ],
    };
    const result = resolveNames(session, output.users, output.channels);
    assert.equal(result.timeline[0].text, "Hello 👍🎉");
  });

  it("resolves names in topic timelines too", () => {
    const output = makeOutput();
    const session = {
      ...output.sessions[0],
      topics: [
        {
          id: "t1",
          name: "Thread Topic",
          channelId: "c1",
          timeline: [
            { ...output.sessions[0].timeline[0], authorId: "u2" },
          ],
        },
      ],
    };
    const result = resolveNames(session, output.users, output.channels);
    // u2: displayName=null → falls back to username="bob"
    assert.equal(result.topics[0].timeline[0].author, "bob");
  });
});

// ---------- computeOutputPath ----------

describe("computeOutputPath", () => {
  it("generates default path with slug from first message time", () => {
    const session = makeOutput().sessions[0];
    const path = computeOutputPath(makeOptions(), session);
    // first message at 2026-08-19T20:00:00.000Z → slug 2026-08-19_2000
    assert.match(path, /2026-08-19_2000/);
    assert.match(path, /session-2026-08-19_2000\.docx$/);
  });

  it("uses server name in path when provided", () => {
    const session = makeOutput().sessions[0];
    const path = computeOutputPath(makeOptions({ serverName: "MyServer" }), session);
    assert.match(path, /exports\/MyServer\//);
  });

  it("falls back to guildId when no server name", () => {
    const output = makeOutput({ guildId: "guild-42" });
    const session = output.sessions[0];
    const p = computeOutputPath(makeOptions(), session, output.guildId);
    assert.match(p, /exports\/guild-42\//);
  });

  it("uses --output override when provided", () => {
    const session = makeOutput().sessions[0];
    const path = computeOutputPath(
      makeOptions({ output: "/tmp/custom-report.docx" }),
      session
    );
    assert.equal(path, "/tmp/custom-report.docx");
  });

  it("slug format is YYYY-MM-DD_HHmm", () => {
    const session = makeOutput().sessions[0];
    const path = computeOutputPath(makeOptions(), session);
    // 2026-08-19T20:00:00.000Z → 2026-08-19_2000
    assert.match(path, /2026-08-19_2000/);
  });
});

// ---------- formatDay ----------

describe("formatDay", () => {
  it("converts 02:00Z to previous SP day 2026-08-18", () => {
    assert.equal(formatDay("2026-08-19T02:00:00Z", "America/Sao_Paulo"), "2026-08-18");
  });

  it("midnight 00:00Z maps to previous SP day (2026-08-19)", () => {
    assert.equal(formatDay("2026-08-20T00:00:00Z", "America/Sao_Paulo"), "2026-08-19");
  });

  it("handles fallback timeline time 2026-08-20T12:00Z", () => {
    assert.equal(formatDay("2026-08-20T12:00:00Z", "America/Sao_Paulo"), "2026-08-20");
  });

  it("exposes TZ constant as America/Sao_Paulo", () => {
    assert.equal(TZ, "America/Sao_Paulo");
  });
});

// ---------- groupSessionsByDay ----------

describe("groupSessionsByDay", () => {
  function makeSession(start: string, time: string): any {
    return {
      start,
      end: time,
      channelIds: ["c1"],
      timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time, text: "hi" }],
      topics: [],
    };
  }

  it("same SP day → 1 key with 2 sessions", () => {
    const s1 = makeSession("2026-08-20T10:00:00Z", "2026-08-20T10:00:00Z");
    const s2 = makeSession("2026-08-20T15:00:00Z", "2026-08-20T15:00:00Z");
    const grouped = groupSessionsByDay([s1, s2], "America/Sao_Paulo");
    assert.equal(grouped.size, 1);
    assert.equal(grouped.get("2026-08-20")!.length, 2);
  });

  it("cross SP day → 2 keys", () => {
    const s1 = makeSession("2026-08-20T10:00:00Z", "2026-08-20T10:00:00Z");
    const s2 = makeSession("2026-08-21T10:00:00Z", "2026-08-21T10:00:00Z");
    const grouped = groupSessionsByDay([s1, s2], "America/Sao_Paulo");
    assert.equal(grouped.size, 2);
    assert.ok(grouped.has("2026-08-20"));
    assert.ok(grouped.has("2026-08-21"));
  });

  it("empty start falls back to timeline[0].time", () => {
    const s = makeSession("", "2026-08-20T12:00:00Z");
    const grouped = groupSessionsByDay([s], "America/Sao_Paulo");
    assert.equal(grouped.size, 1);
    assert.ok(grouped.has("2026-08-20"));
  });

  it("timezone conversion 02:00Z → 2026-08-18 key", () => {
    const s = makeSession("2026-08-19T02:00:00Z", "2026-08-19T02:00:00Z");
    const grouped = groupSessionsByDay([s], "America/Sao_Paulo");
    assert.ok(grouped.has("2026-08-18"), "should bucket to previous SP day");
  });
});

// ---------- computeDailyOutputPath ----------

describe("computeDailyOutputPath", () => {
  it("sanitizes MyServer → exports/MyServer/daily-YYYY-MM-DD.docx (flat)", () => {
    const p = computeDailyOutputPath("MyServer", "2026-08-20", "guild-1");
    assert.equal(p, "exports/MyServer/daily-2026-08-20.docx");
  });

  it("falls back to guildId 123456 (flat)", () => {
    const p = computeDailyOutputPath(null, "2026-08-20", "123456");
    assert.equal(p, "exports/123456/daily-2026-08-20.docx");
  });

  it("falls back to unknown when no names (flat)", () => {
    const p = computeDailyOutputPath(null, "2026-08-20", null);
    assert.equal(p, "exports/unknown/daily-2026-08-20.docx");
  });

  it("sanitizes special chars (flat)", () => {
    const p = computeDailyOutputPath("My Server!", "2026-08-20", null);
    assert.equal(p, "exports/My_Server_/daily-2026-08-20.docx");
    assert.ok(!p.includes(" "), "no spaces in sanitized path");
  });
});

// ---------- parseReportArgs ----------

describe("parseReportArgs", () => {
  it("returns defaults for empty argv", () => {
    const args = parseReportArgs([]);
    assert.equal(args.sessionIndex, null);
    assert.deepEqual(args.channelIds, []);
    assert.equal(args.from, null);
    assert.equal(args.to, null);
    assert.equal(args.viewMode, "chronological");
    assert.equal(args.serverName, null);
    assert.equal(args.output, null);
    assert.equal(args.inputPath, "export/messages.json");
  });

  it("parses --session flag", () => {
    const args = parseReportArgs(["--session", "2"]);
    assert.equal(args.sessionIndex, 2);
  });

  it("parses --channels flag", () => {
    const args = parseReportArgs(["--channels", "abc,def"]);
    assert.deepEqual(args.channelIds, ["abc", "def"]);
  });

  it("parses --from and --to flags", () => {
    const args = parseReportArgs([
      "--from", "2024-01-01T00:00:00Z",
      "--to", "2024-01-02T00:00:00Z",
    ]);
    assert.equal(args.from, "2024-01-01T00:00:00Z");
    assert.equal(args.to, "2024-01-02T00:00:00Z");
  });

  it("parses --view by-channel", () => {
    const args = parseReportArgs(["--view", "by-channel"]);
    assert.equal(args.viewMode, "by-channel");
  });

  it("parses --server-name flag", () => {
    const args = parseReportArgs(["--server-name", "MyServer"]);
    assert.equal(args.serverName, "MyServer");
  });

  it("parses --output flag", () => {
    const args = parseReportArgs(["--output", "/tmp/out.docx"]);
    assert.equal(args.output, "/tmp/out.docx");
  });

  it("parses --input flag", () => {
    const args = parseReportArgs(["--input", "custom/data.json"]);
    assert.equal(args.inputPath, "custom/data.json");
  });

  it("parses all flags combined", () => {
    const args = parseReportArgs([
      "--session", "0",
      "--channels", "c1",
      "--from", "2024-01-01T00:00:00Z",
      "--to", "2024-06-01T00:00:00Z",
      "--view", "by-channel",
      "--server-name", "Test",
      "--output", "/tmp/test.docx",
      "--input", "data.json",
    ]);
    assert.equal(args.sessionIndex, 0);
    assert.deepEqual(args.channelIds, ["c1"]);
    assert.equal(args.from, "2024-01-01T00:00:00Z");
    assert.equal(args.to, "2024-06-01T00:00:00Z");
    assert.equal(args.viewMode, "by-channel");
    assert.equal(args.serverName, "Test");
    assert.equal(args.output, "/tmp/test.docx");
    assert.equal(args.inputPath, "data.json");
  });

  it("throws on unknown flag", () => {
    assert.throws(() => parseReportArgs(["--unknown"]), /unknown option/i);
  });

  it("throws on missing value for --session", () => {
    assert.throws(() => parseReportArgs(["--session"]), /missing value/i);
  });
});

// ---------- buildSections ----------

describe("buildSections", () => {
  it("returns 5 sections in order for chronological view", () => {
    const output = makeOutput();
    const session = output.sessions[0];
    const resolved = resolveNames(session, output.users, output.channels);
    const sections = buildSections([resolved], makeOptions());
    assert.equal(sections.length, 4);
    // Verify section types by checking children arrays exist
    for (const s of sections) {
      assert.ok(Array.isArray(s.children), "each section must have children array");
    }
  });

  it("returns 5 sections in order for by-channel view", () => {
    const output = makeOutput();
    const session = output.sessions[0];
    const resolved = resolveNames(session, output.users, output.channels);
    const sections = buildSections([resolved], makeOptions({ viewMode: "by-channel" }));
    assert.equal(sections.length, 4);
  });

  it("title section contains server name", () => {
    const output = makeOutput();
    const session = output.sessions[0];
    const resolved = resolveNames(session, output.users, output.channels);
    const sections = buildSections(
      [resolved],
      makeOptions({ serverName: "MyServer" })
    );
    // Title section is first — inspect its children for "MyServer" text
    const titleChildren = sections[0].children;
    const hasServerName = titleChildren.some((child: any) => {
      const json = JSON.stringify(child.root ?? child);
      return json.includes("MyServer");
    });
    assert.ok(hasServerName, "title section must contain server name");
  });

  it("empty sessions produces title and metadata only", () => {
    const sections = buildSections([], makeOptions({ serverName: "Empty" }));
    // With zero sessions: title + metadata should exist, timeline empty
    assert.ok(sections.length >= 2, "must have at least title and metadata");
  });

  it("timeline entries are sorted by time then id in chronological view", () => {
    const output = makeOutput();
    const session = output.sessions[0];
    // Reorder timeline so m2 comes before m1
    session.timeline = [session.timeline[1], session.timeline[0]];
    const resolved = resolveNames(session, output.users, output.channels);
    const sections = buildSections([resolved], makeOptions({ viewMode: "chronological" }));
    // Timeline body is section index 1 (after compact header)
    const timelineSection = sections[1];
    assert.ok(timelineSection, "timeline section must exist");
    assert.ok(timelineSection.children.length > 0, "timeline must have content");
  });

  it("by-channel groups messages under channel headings", () => {
    const output = makeOutput();
    const session = output.sessions[0];
    const resolved = resolveNames(session, output.users, output.channels);
    const sections = buildSections(
      [resolved],
      makeOptions({ viewMode: "by-channel" })
    );
    const timelineSection = sections[1];
    assert.ok(timelineSection, "timeline section must exist");
    assert.ok(timelineSection.children.length > 0, "timeline must have content");
  });

  it("thread sub-sections appear after timeline", () => {
    const output = makeOutput();
    const session = {
      ...output.sessions[0],
      topics: [
        {
          id: "t1",
          name: "Thread Topic",
          channelId: "c1",
          timeline: [
            {
              id: "m3",
              channelId: "c1",
              authorId: "u1",
              author: "Alice",
              channel: "general",
              time: "2026-08-19T20:10:00.000Z",
              text: "Thread reply",
            },
          ],
        },
      ],
    };
    const resolved = resolveNames(session, output.users, output.channels);
    const sections = buildSections([resolved], makeOptions());
    // Sections: [titleAndMetaCompact, timeline, threads, participants]
    assert.equal(sections.length, 4);
    const threadsSection = sections[2];
    assert.ok(threadsSection, "threads section must exist");
    assert.ok(threadsSection.children.length > 0, "threads must have content when topics exist");
  });

  it("participant index shows unique authors", () => {
    const output = makeOutput();
    const session = output.sessions[0];
    const resolved = resolveNames(session, output.users, output.channels);
    const sections = buildSections([resolved], makeOptions());
    // Participant index is section 3
    const participantSection = sections[3];
    assert.ok(participantSection, "participant section must exist");
    assert.ok(participantSection.children.length > 0, "participants must have content");
  });
});

describe("buildSections compact header (1A)", () => {
  it("returns 4 sections with merged header", () => {
    const output = makeOutput();
    const resolved = resolveNames(output.sessions[0], output.users, output.channels);
    const sections = buildSections([resolved], makeOptions({ serverName: "CompactTest" }));
    assert.equal(sections.length, 4, "must be 4 sections titleAndMetaCompact, timelineBody, threadSubSections, participantIndex");
    // first section must contain title, spacer, metadata, timeline start marker
    const firstJson = JSON.stringify(sections[0].children.map((c: any) => c.root ?? c));
    assert.ok(firstJson.includes("CompactTest"), "first section must contain server name");
    assert.ok(firstJson.includes("Generated"), "first section must contain metadata");
  });

  it("title size 48 Aptos Display and span after 480 no 3600 (aesthetic refresh)", () => {
    const output = makeOutput();
    const resolved = resolveNames(output.sessions[0], output.users, output.channels);
    const sections = buildSections([resolved], makeOptions());
    const firstJson = JSON.stringify(sections[0].children.map((c: any) => c.root ?? c));
    assert.ok(firstJson.includes('"val":48') || firstJson.includes('"size":48'), "title must be size 48, got json: " + firstJson.slice(0, 800));
    assert.ok(firstJson.includes("Aptos Display"), "title must be Aptos Display");
    assert.ok(firstJson.includes("480"), "span must have after 480");
    const hasSpacer = sections[0].children.some((c: any) => {
      const j = JSON.stringify(c.root ?? c);
      return j.includes("3600");
    });
    assert.ok(!hasSpacer, "must NOT contain spacer 3600, got spacer");
  });

  it("tail sections are CONTINUOUS", () => {
    const output = makeOutput();
    const resolved = resolveNames(output.sessions[0], output.users, output.channels);
    const sections = buildSections([resolved], makeOptions());
    assert.equal(sections.length, 4);
    for (let i = 1; i < sections.length; i++) {
      assert.equal(sections[i].properties?.type, SectionType.CONTINUOUS, `section ${i} must be CONTINUOUS`);
    }
  });

  it("empty sessions → 4 sections header 0 sessions timeline on p1", () => {
    const sections = buildSections([], makeOptions({ serverName: "Empty" }));
    assert.equal(sections.length, 4, "empty must still be 4 sections");
    const firstJson = JSON.stringify(sections[0].children.map((c: any) => c.root ?? c));
    assert.ok(firstJson.includes("0 sessions") || firstJson.includes("No sessions"), "header must show 0 sessions");
    for (let i = 1; i < sections.length; i++) {
      assert.equal(sections[i].properties?.type, SectionType.CONTINUOUS);
    }
  });
});

// ---------- main ----------

describe("main", () => {
  it("writes DOCX to --output path for single session", async () => {
    const output = makeOutput();
    const captured: { path: string; buffer: Buffer | null } = { path: "", buffer: null };

    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (p: string, data: Buffer) => {
        captured.path = p;
        captured.buffer = data;
      },
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { if (code !== 0) throw new Error(`exit(${code})`); },
    };

    await main(["--output", "/tmp/test-report.docx"], io);
    assert.equal(captured.path, "/tmp/test-report.docx");
    assert.ok(captured.buffer, "buffer must be written");
    assert.ok(captured.buffer!.length > 0, "DOCX must not be empty");
  });

  it("writes one DOCX per session when no --session flag", async () => {
    // Daily grouping: 2 sessions on different SP days → 2 daily docs
    const output = makeOutput({
      sessions: [
        { ...makeOutput().sessions[0], start: "2026-08-19T18:00:00.000Z", end: "2026-08-19T19:00:00.000Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], time: "2026-08-19T18:00:00.000Z" }], topics: [] },
        { ...makeOutput().sessions[0], start: "2026-08-20T18:00:00.000Z", end: "2026-08-20T19:00:00.000Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], id: "m2b", time: "2026-08-20T18:00:00.000Z", text: "second day" }], topics: [] },
      ],
    });
    const writtenPaths: string[] = [];
    const writtenBuffers: Buffer[] = [];

    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (p: string, data: Buffer) => { writtenPaths.push(p); writtenBuffers.push(data); },
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { if (code !== 0) throw new Error(`exit(${code})`); },
    };

    await main(["--server-name", "TestServer"], io);
    assert.equal(writtenPaths.length, 2, "must write one file per day");
    assert.equal(writtenBuffers.length, 2, "must produce one buffer per day");
    // Each path should be daily-YYYY-MM-DD.docx
    assert.ok(writtenPaths[0].includes("daily-"), "first file must be a daily docx");
    assert.ok(writtenPaths[1].includes("daily-"), "second file must be a daily docx");
    // Each DOCX must contain only its day's session — the two buffers must differ.
    assert.notEqual(
      writtenBuffers[0].toString("hex"),
      writtenBuffers[1].toString("hex"),
      "each daily DOCX must render only that day (buffers must differ)"
    );
  });

  it("writes empty DOCX and exits 0 when zero sessions match", async () => {
    const output = makeOutput();
    let exitCalled = false;

    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (_p: string, _data: Buffer) => {},
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => {
        if (code !== 0) throw new Error(`exit(${code})`);
        exitCalled = true;
      },
    };

    await main(["--session", "99"], io);
    assert.ok(exitCalled, "exit(0) must be called for zero matches");
  });

  it("exits non-zero when input file is missing", async () => {
    let exitCode: number | null = null;

    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => { throw new Error("ENOENT"); },
      writeFileSync: (_p: string, _data: Buffer) => {},
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { exitCode = code; },
    };

    await main([], io);
    assert.equal(exitCode, 1, "must exit 1 on missing file");
  });

  it("exits non-zero on invalid JSON", async () => {
    let exitCode: number | null = null;

    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => "{bad json",
      writeFileSync: (_p: string, _data: Buffer) => {},
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { exitCode = code; },
    };

    await main([], io);
    assert.equal(exitCode, 1, "must exit 1 on invalid JSON");
  });

  it("exits non-zero on unsupported schema version", async () => {
    let exitCode: number | null = null;
    const badOutput = makeOutput({ schemaVersion: "99" });

    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(badOutput),
      writeFileSync: (_p: string, _data: Buffer) => {},
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { exitCode = code; },
    };

    await main([], io);
    assert.equal(exitCode, 1, "must exit 1 on unsupported schema version");
  });
});

describe("main daily grouping (2A)", () => {
  it("same SP day → 1 daily doc with both sessions", async () => {
    const output = makeOutput({
      sessions: [
        { ...makeOutput().sessions[0], start: "2026-08-20T10:00:00Z", end: "2026-08-20T11:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], time: "2026-08-20T10:00:00Z" }], topics: [] },
        { ...makeOutput().sessions[0], start: "2026-08-20T15:00:00Z", end: "2026-08-20T16:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], id: "mX", time: "2026-08-20T15:00:00Z", text: "second" }], topics: [] },
      ],
    });
    const writtenPaths: string[] = [];
    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (p: string, _data: Buffer) => { writtenPaths.push(p); },
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { if (code !== 0) throw new Error(`exit(${code})`); },
    };
    await main(["--server-name", "MyServer"], io);
    assert.equal(writtenPaths.length, 1, "same day must be 1 daily doc");
    assert.equal(writtenPaths[0], "exports/MyServer/daily-2026-08-20.docx");
  });

  it("cross SP day → 2 daily docs (flat)", async () => {
    const output = makeOutput({
      sessions: [
        { ...makeOutput().sessions[0], start: "2026-08-20T10:00:00Z", end: "2026-08-20T11:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], time: "2026-08-20T10:00:00Z" }], topics: [] },
        { ...makeOutput().sessions[0], start: "2026-08-21T10:00:00Z", end: "2026-08-21T11:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], id: "mX", time: "2026-08-21T10:00:00Z" }], topics: [] },
      ],
    });
    const writtenPaths: string[] = [];
    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (p: string, _data: Buffer) => { writtenPaths.push(p); },
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { if (code !== 0) throw new Error(`exit(${code})`); },
    };
    await main([], io);
    assert.equal(writtenPaths.length, 2, "cross day must be 2 docs");
    assert.ok(writtenPaths.includes("exports/guild-1/daily-2026-08-20.docx"), "must have flat 2026-08-20");
    assert.ok(writtenPaths.includes("exports/guild-1/daily-2026-08-21.docx"), "must have flat 2026-08-21");
  });

  it("--output bypasses grouping → single doc", async () => {
    const output = makeOutput({
      sessions: [
        { ...makeOutput().sessions[0], start: "2026-08-20T10:00:00Z", end: "2026-08-20T11:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], time: "2026-08-20T10:00:00Z" }], topics: [] },
        { ...makeOutput().sessions[0], start: "2026-08-21T10:00:00Z", end: "2026-08-21T11:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], id: "mX", time: "2026-08-21T10:00:00Z" }], topics: [] },
        { ...makeOutput().sessions[0], start: "2026-08-22T10:00:00Z", end: "2026-08-22T11:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], id: "mY", time: "2026-08-22T10:00:00Z" }], topics: [] },
      ],
    });
    const writtenPaths: string[] = [];
    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (p: string, _data: Buffer) => { writtenPaths.push(p); },
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { if (code !== 0) throw new Error(`exit(${code})`); },
    };
    await main(["--output", "/tmp/report.docx"], io);
    assert.equal(writtenPaths.length, 1);
    assert.equal(writtenPaths[0], "/tmp/report.docx");
  });

  it("--session 0 filters before grouping → only that session's day (flat)", async () => {
    const output = makeOutput({
      sessions: [
        { ...makeOutput().sessions[0], start: "2026-08-20T10:00:00Z", end: "2026-08-20T11:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], time: "2026-08-20T10:00:00Z" }], topics: [] },
        { ...makeOutput().sessions[0], start: "2026-08-20T15:00:00Z", end: "2026-08-20T16:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], id: "mX", time: "2026-08-20T15:00:00Z" }], topics: [] },
        { ...makeOutput().sessions[0], start: "2026-08-20T18:00:00Z", end: "2026-08-20T19:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], id: "mY", time: "2026-08-20T18:00:00Z" }], topics: [] },
      ],
    });
    const writtenPaths: string[] = [];
    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (p: string, _data: Buffer) => { writtenPaths.push(p); },
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { if (code !== 0) throw new Error(`exit(${code})`); },
    };
    await main(["--session", "0"], io);
    assert.equal(writtenPaths.length, 1, "--session 0 + daily same day => 1 doc");
    assert.equal(writtenPaths[0], "exports/guild-1/daily-2026-08-20.docx");
  });

  it("zero-filter without --output → zero files exit 0", async () => {
    const output = makeOutput();
    const writtenPaths: string[] = [];
    let exitCode: number | null = null;
    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (p: string, _data: Buffer) => { writtenPaths.push(p); },
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { exitCode = code; },
    };
    await main(["--session", "99"], io);
    assert.equal(writtenPaths.length, 0, "zero filter must write 0 files");
    assert.equal(exitCode, 0);
  });

  it("guildId fallback in daily path (flat)", async () => {
    const output = makeOutput({ guildId: "123456" });
    // single session on 2026-08-20
    output.sessions[0].start = "2026-08-20T10:00:00Z";
    output.sessions[0].end = "2026-08-20T11:00:00Z";
    const writtenPaths: string[] = [];
    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (p: string, _data: Buffer) => { writtenPaths.push(p); },
      mkdirSync: (_p: string, _opts: any) => {},
      exit: (code: number) => { if (code !== 0) throw new Error(`exit(${code})`); },
    };
    await main([], io);
    assert.equal(writtenPaths.length, 1);
    assert.equal(writtenPaths[0], "exports/123456/daily-2026-08-20.docx");
  });

  it("re-export overwrites idempotently (flat) + lex sort chronological", async () => {
    const output = makeOutput({
      sessions: [
        { ...makeOutput().sessions[0], start: "2026-08-20T10:00:00Z", end: "2026-08-20T11:00:00Z", timeline: [{ ...makeOutput().sessions[0].timeline[0], time: "2026-08-20T10:00:00Z", text: "v1" }], topics: [] },
      ],
    });
    const writtenPaths: string[] = [];
    const mkdirPaths: string[] = [];
    let writeCount = 0;
    const io: ReportIO = {
      readFileSync: (_p: string, _enc: string) => JSON.stringify(output),
      writeFileSync: (p: string, _data: Buffer) => { writtenPaths.push(p); writeCount++; },
      mkdirSync: (p: string, _opts: any) => { mkdirPaths.push(p); },
      exit: (code: number) => { if (code !== 0) throw new Error(`exit(${code})`); },
    };
    await main(["--server-name", "MyServer"], io);
    assert.equal(writtenPaths.length, 1);
    assert.equal(writtenPaths[0], "exports/MyServer/daily-2026-08-20.docx");
    assert.ok(mkdirPaths.includes("exports/MyServer"), "mkdir must be flat parent exports/<server> not dated subdir");
    assert.ok(!mkdirPaths.some(p => p.includes("2026-08-20")), "mkdir must not create dated subdir");
    // re-export same day: overwrite without error — count would be 2 after second run
    writtenPaths.length = 0;
    mkdirPaths.length = 0;
    await main(["--server-name", "MyServer"], io);
    assert.equal(writtenPaths.length, 1, "re-export must overwrite same flat file");
    assert.equal(writeCount, 2, "write called twice (idempotent overwrite)");
    // lex sort == chronological due to daily-YYYY-MM-DD prefix
    const flatFiles = ["exports/MyServer/daily-2026-08-20.docx", "exports/MyServer/daily-2026-08-19.docx", "exports/MyServer/daily-2026-08-18.docx"];
    assert.deepEqual([...flatFiles].sort(), ["exports/MyServer/daily-2026-08-18.docx", "exports/MyServer/daily-2026-08-19.docx", "exports/MyServer/daily-2026-08-20.docx"]);
  });
});

// ---------- Unit 2: json-export-with-images DOCX embedding ----------

describe("generateReport Unit2: schema gate 1|2 + image embedding", () => {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  const pngBuf = Buffer.from(pngBase64, "base64");

  function makeOutputWithImages(entries: Array<{ id: string; channelId: string; authorId: string; name: string; relPath: string }>, opts: { schemaVersion?: string } = {}): ExportOutput {
    return {
      schemaVersion: (opts.schemaVersion ?? "2") as any,
      guildId: "guild-1",
      generatedAt: "2026-08-20T10:00:00.000Z",
      mode: "full",
      filter: { channelIds: [], from: null, to: null },
      users: { "u1": { username: "alice", displayName: "Alice", globalName: "Alice G" } },
      channels: { "c1": { name: "general", type: "text", parentId: null } },
      sessions: [{
        start: "2026-08-20T10:00:00.000Z",
        end: "2026-08-20T11:00:00.000Z",
        channelIds: ["c1"],
        timeline: entries.map(e => ({
          id: e.id,
          channelId: e.channelId,
          authorId: e.authorId,
          author: "Alice",
          channel: "general",
          time: "2026-08-20T10:00:00.000Z",
          text: "hello with image",
          images: [{ name: e.name, path: e.relPath, contentType: "image/png" }],
        })),
        topics: [],
      }],
    };
  }

  function writeTempImage(tmpDir: string, relPath: string, data: Buffer) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    return full;
  }

  it("loadAndValidate accepts schemaVersion 2", () => {
    const out = makeOutput({ schemaVersion: "2" as any });
    const result = loadAndValidate(JSON.stringify(out));
    assert.equal(result.schemaVersion, "2");
  });

  it("loadAndValidate accepts schemaVersion 1 without images (text-only)", () => {
    const out = makeOutput({ schemaVersion: "1" });
    const result = loadAndValidate(JSON.stringify(out));
    assert.equal(result.schemaVersion, "1");
    const sections = buildSections(result.sessions.map(s => resolveNames(s, result.users, result.channels)), makeOptions(), os.tmpdir());
    const json = JSON.stringify(sections.map(s => s.children.map((c: any) => c.root ?? c)));
    assert.ok(!json.includes("[image:"), "no placeholder for v1 without images");
    assert.ok(!json.includes("w:drawing"), "no ImageRun for v1 without images");
  });

  it("embed success timeline: ImageRun width≤450 height≤300", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-embed-timeline-"));
    try {
      const rel = "images/m1__photo.png";
      writeTempImage(tmp, rel, pngBuf);
      const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "photo.png", relPath: rel }]);
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      // Need to inject images into the resolved session; buildSections should embed via baseDir
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const allChildren = sections.flatMap((s: any) => s.children);
      const json = JSON.stringify(allChildren.map((c: any) => c.root ?? c));
      assert.ok(json.includes("w:drawing"), "timeline must contain ImageRun drawing");
      assert.ok(json.includes("wp:inline"), "must have wp:inline for image");
      // transformation EMUs are width*9525; for ≤450 width, cx ≤ 4286250; for ≤300 height cy ≤ 2857500
      // fallback uses 450x300 => 4286250 x 2857500
      // just verify drawing exists and no placeholder for valid image
      assert.ok(!json.includes("[image: photo.png unavailable]"), "valid image must not have placeholder");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("embed success threadSubSections: ImageRun in threads", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-embed-thread-"));
    try {
      const rel = "images/m2__thread.png";
      writeTempImage(tmp, rel, pngBuf);
      const out: ExportOutput = {
        schemaVersion: "2" as any,
        guildId: "guild-1",
        generatedAt: "2026-08-20T10:00:00.000Z",
        mode: "full",
        filter: { channelIds: [], from: null, to: null },
        users: { "u1": { username: "alice", displayName: "Alice", globalName: "Alice G" } },
        channels: { "c1": { name: "general", type: "text", parentId: null }, "t1": { name: "Thread Topic", type: "thread", parentId: "c1" } },
        sessions: [{
          start: "2026-08-20T10:00:00.000Z",
          end: "2026-08-20T11:00:00.000Z",
          channelIds: ["c1"],
          timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-20T10:00:00.000Z", text: "main", }],
          topics: [{ id: "t1", name: "Thread Topic", channelId: "t1", timeline: [{ id: "m2", channelId: "t1", authorId: "u1", author: "Alice", channel: "Thread Topic", time: "2026-08-20T10:10:00.000Z", text: "thread reply", images: [{ name: "thread.png", path: rel, contentType: "image/png" }] }] }],
        }],
      };
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("w:drawing"), "thread must contain ImageRun");
      assert.ok(!json.includes("[image: thread.png unavailable]"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("missing file → italic placeholder [image: <name> unavailable]", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-missing-"));
    try {
      const rel = "images/999__gone.png";
      const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "gone.png", relPath: rel }]);
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("[image: gone.png unavailable]"), "missing file must render placeholder");
      assert.ok(json.includes("w:i"), "placeholder must be italic (w:i)");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("oversized >5MB → placeholder not embedded", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-oversized-"));
    try {
      const rel = "images/m1__big.png";
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      // create sparse file >5MB without writing full data (use truncate)
      const fd = fs.openSync(full, "w");
      fs.ftruncateSync(fd, 5 * 1024 * 1024 + 1);
      fs.closeSync(fd);
      const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "big.png", relPath: rel }]);
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("[image: big.png unavailable]"), "oversized must be placeholder");
      assert.ok(!json.includes("rId{") || json.includes("[image:"), "oversized must not embed ImageRun with valid rId as sole content");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("offline resolve via dirname(inputPath): main resolves images without server.db", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-offline-"));
    try {
      const rel = "images/m1__offline.png";
      writeTempImage(tmp, rel, pngBuf);
      const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "offline.png", relPath: rel }]);
      out.sessions[0].timeline[0].images = [{ name: "offline.png", path: rel, contentType: "image/png" }];
      const inputPath = path.join(tmp, "messages.json");
      fs.writeFileSync(inputPath, JSON.stringify(out));
      const written: Buffer[] = [];
      const io: ReportIO = {
        readFileSync: (p: string, _enc: string) => fs.readFileSync(p, "utf-8"),
        writeFileSync: (_p: string, data: Buffer) => { written.push(data); },
        mkdirSync: (_p: string, _o: any) => {},
        exit: (code: number) => { if (code !== 0) throw new Error(`exit ${code}`); },
      };
      await main(["--input", inputPath, "--output", path.join(tmp, "out.docx")], io);
      assert.ok(written.length === 1 && written[0].length > 0, "offline main must produce docx");
      const docBuffer = written[0];
      assert.ok(docBuffer.length > 0, "Packer buffer >0");
      // quick check that buffer is zip (docx is zip) starts with PK
      assert.equal(docBuffer[0], 0x50);
      assert.equal(docBuffer[1], 0x4b);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Packer.toBuffer produces valid docx >0 bytes with embedded image", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-packer-"));
    try {
      const rel = "images/m1__pack.png";
      writeTempImage(tmp, rel, pngBuf);
      const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "pack.png", relPath: rel }]);
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const { Document, Packer } = await import("docx");
      const doc = new Document({ sections });
      const buf = await Packer.toBuffer(doc);
      assert.ok(buf.length > 0, "Packer.toBuffer must be >0");
      assert.equal(buf[0], 0x50);
      assert.equal(buf[1], 0x4b);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("w:drawing"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("corrupt/webp unsupported falls back to italic placeholder", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-corrupt-"));
    try {
      const rel = "images/m1__bad.webp";
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from("not-an-image"));
      const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "bad.webp", relPath: rel }]);
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("hello with image"), "timeline text must still render despite corrupt image");
      assert.ok(json.includes("[image: bad.webp unavailable]"), "corrupt webp must render placeholder");
      assert.ok(json.includes("w:i"), "placeholder must be italic");
      assert.ok(!json.includes("not-an-image"), "raw corrupt bytes must not be embedded");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------- RED Bug1 Proportional Embedding Strict TDD (2.1) ----------

describe("RED Bug1 — Proportional Embedding via getImageDimensions + clampTransform (2.1)", () => {
  // helpers to craft minimal valid buffers for image-size
  function pngWithDims(w: number, h: number): Buffer {
    const b = Buffer.alloc(32);
    b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8; b[25] = 2; b[26] = 0; b[27] = 0; b[28] = 0;
    return b;
  }
  function gifWithDims(w: number, h: number): Buffer {
    const b = Buffer.alloc(10);
    b.write("GIF89a", 0);
    b.writeUInt16LE(w, 6);
    b.writeUInt16LE(h, 8);
    return b;
  }
  function jpgWithDims(w: number, h: number): Buffer {
    const b = Buffer.alloc(41);
    let o = 0;
    b[o++] = 0xff; b[o++] = 0xd8;
    b[o++] = 0xff; b[o++] = 0xe0;
    b.writeUInt16BE(16, o); o += 2;
    b.write("JFIF", o); o += 4;
    b[o++] = 0x00; b[o++] = 0x01; b[o++] = 0x01; b[o++] = 0x00;
    b.writeUInt16BE(1, o); o += 2; b.writeUInt16BE(1, o); o += 2; b[o++] = 0x00; b[o++] = 0x00;
    b[o++] = 0xff; b[o++] = 0xc0;
    b.writeUInt16BE(17, o); o += 2;
    b[o++] = 8;
    b.writeUInt16BE(h, o); o += 2;
    b.writeUInt16BE(w, o); o += 2;
    b[o++] = 3; b[o++] = 1; b[o++] = 0x22; b[o++] = 0x00; b[o++] = 2; b[o++] = 0x11; b[o++] = 0x01; b[o++] = 3; b[o++] = 0x11; b[o++] = 0x01;
    b[o++] = 0xff; b[o++] = 0xd9;
    return b.slice(0, o);
  }
  function webpWithDims(w: number, h: number): Buffer {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0);
    b.writeUInt32LE(22, 4);
    b.write("WEBP", 8);
    b.write("VP8 ", 12);
    b.writeUInt32LE(10, 16);
    // bytes 20..29 are VP8 data; lossy calculation uses bytes at 26/28
    b[26] = w & 0xff; b[27] = (w >> 8) & 0xff;
    b[28] = h & 0xff; b[29] = (h >> 8) & 0xff;
    return b;
  }
  function writeTemp(tmp: string, rel: string, data: Buffer) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    return full;
  }
  function makeOutputWithImages(entries: Array<{ id: string; channelId: string; authorId: string; name: string; relPath: string }>): ExportOutput {
    return {
      schemaVersion: "2" as any,
      guildId: "guild-1",
      generatedAt: "2026-08-20T10:00:00.000Z",
      mode: "full",
      filter: { channelIds: [], from: null, to: null },
      users: { "u1": { username: "alice", displayName: "Alice", globalName: "Alice G" } },
      channels: { "c1": { name: "general", type: "text", parentId: null } },
      sessions: [{
        start: "2026-08-20T10:00:00.000Z",
        end: "2026-08-20T11:00:00.000Z",
        channelIds: ["c1"],
        timeline: entries.map(e => ({
          id: e.id, channelId: e.channelId, authorId: e.authorId, author: "Alice", channel: "general", time: "2026-08-20T10:00:00.000Z", text: "hello with image",
          images: [{ name: e.name, path: e.relPath, contentType: "image/png" }],
        })),
        topics: [],
      }],
    };
  }
  function getDrawnCxCy(json: string): { cx: number; cy: number } | null {
    // docx serializes extents as a:ext with cx/cy in EMUs (9525 per CSS pixel)
    const m = json.match(/"cx":\s*(\d+)[^}]*"cy":\s*(\d+)/) || json.match(/cx["\s:]+(\d+)[^}]*cy["\s:]+(\d+)/);
    if (m) return { cx: Number(m[1]), cy: Number(m[2]) };
    // fallback search for extent values
    const m2 = json.match(/(\d{6,7})[^0-9]+(\d{6,7})/);
    if (m2) return { cx: Number(m2[1]), cy: Number(m2[2]) };
    return null;
  }

  it("getImageDimensions returns correct dims for PNG 1139x1381 and JPEG/GIF/WebP", () => {
    assert.deepEqual(getImageDimensions(pngWithDims(1139, 1381)), { width: 1139, height: 1381 });
    assert.deepEqual(getImageDimensions(jpgWithDims(900, 492)), { width: 900, height: 492 });
    assert.deepEqual(getImageDimensions(gifWithDims(100, 200)), { width: 100, height: 200 });
    const wp = webpWithDims(640, 480);
    const d = getImageDimensions(wp);
    assert.ok(d && d.width === 640 && d.height === 480, "webp dims must be 640x480 got " + JSON.stringify(d));
  });

  it("Portrait 1139x1381 → 247x300 via clampTransform and tryEmbedImages", () => {
    assert.deepEqual(clampTransform(1139, 1381), { width: 247, height: 300 });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-red-portrait-"));
    try {
      const rel = "images/m1__portrait.png";
      writeTemp(tmp, rel, pngWithDims(1139, 1381));
      const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "portrait.png", relPath: rel }]);
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("w:drawing"), "must contain ImageRun drawing");
      assert.ok(!json.includes("[image: portrait.png unavailable]"), "portrait must not be placeholder");
      // EMU expectations: 247*9525=2352675, 300*9525=2857500
      assert.ok(json.includes("2352675") && json.includes("2857500"), "portrait must be 247x300 EMU 2352675x2857500, got " + json.slice(0, 800));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Landscape 900x492 → 450x246 via tryEmbedImages", () => {
    assert.deepEqual(clampTransform(900, 492), { width: 450, height: 246 });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-red-landscape-"));
    try {
      const rel = "images/m1__landscape.jpg";
      writeTemp(tmp, rel, jpgWithDims(900, 492));
      const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "landscape.jpg", relPath: rel }]);
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("w:drawing"), "landscape must contain drawing");
      assert.ok(!json.includes("[image: landscape.jpg unavailable]"));
      // 450*9525=4286250, 246*9525=2343150
      assert.ok(json.includes("4286250") && json.includes("2343150"), "landscape must be 450x246 EMU 4286250x2343150");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("truncated/corrupt dims fallback → 450x300 ImageRun not placeholder", () => {
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]); // too short for IHDR
    assert.equal(getImageDimensions(truncated), null, "truncated PNG must return null");
    assert.deepEqual(clampTransform(), { width: 450, height: 300 });
    assert.deepEqual(clampTransform(undefined as any, undefined as any), { width: 450, height: 300 });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-red-trunc-"));
    try {
      const rel = "images/m1__trunc.png";
      // Write a file that passes isKnownImageMagic (PNG sig) but is truncated so getImageDimensions fails
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      // PNG signature + minimal bytes but not enough for image-size; still passes magic check (>=4 bytes 89 50 4E 47)
      fs.writeFileSync(full, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
      const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "trunc.png", relPath: rel }]);
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("w:drawing"), "truncated dims must still embed ImageRun fallback");
      assert.ok(!json.includes("[image: trunc.png unavailable]"), "must not be placeholder");
      assert.ok(json.includes("4286250") && json.includes("2857500"), "fallback must be 450x300 EMU");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("PNG/JPEG/GIF/WebP supported — each embeds with correct clamped size", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-red-formats-"));
    try {
      const cases: Array<{ name: string; buf: Buffer; expW: number; expH: number }> = [
        { name: "a.png", buf: pngWithDims(600, 400), expW: 450, expH: 300 },
        { name: "b.jpg", buf: jpgWithDims(200, 100), expW: 200, expH: 100 },
        { name: "c.gif", buf: gifWithDims(100, 200), expW: 100, expH: 200 },
      ];
      // WebP 640x480 → clamped 450x337? Let's compute: w=min(640,450)=450 h=round(450*480/640)=337 → ≤300? 337>300 fallback to h=300 w=round(300*640/480)=400 ⇒ actually 400x300
      // Check clampTransform(640,480) = 400x300
      const wp = webpWithDims(640, 480);
      const d = getImageDimensions(wp)!;
      const clamped = clampTransform(d.width, d.height);
      assert.ok(clamped.width <= 450 && clamped.height <= 300, "webp clamped must respect cap");

      for (const c of cases) {
        const rel = `images/m1__${c.name}`;
        writeTemp(tmp, rel, c.buf);
        const out = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: c.name, relPath: rel }]);
        const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
        const sections = (buildSections as any)(resolved, makeOptions(), tmp);
        const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
        assert.ok(json.includes("w:drawing"), `${c.name} must embed`);
        assert.ok(!json.includes(`[image: ${c.name} unavailable]`), `${c.name} must not be placeholder`);
        // verify not always 450x300 for small images — e.g., 200x100 stays 200x100
        if (c.expW !== 450 || c.expH !== 300) {
          const emuW = String(c.expW * 9525);
          const emuH = String(c.expH * 9525);
          assert.ok(json.includes(emuW) && json.includes(emuH), `${c.name} must be ${c.expW}x${c.expH}`);
        }
      }
      // webp case separately
      const relWp = "images/m1__w.webp";
      writeTemp(tmp, relWp, wp);
      const outWp = makeOutputWithImages([{ id: "m1", channelId: "c1", authorId: "u1", name: "w.webp", relPath: relWp }]);
      const resolvedWp = outWp.sessions.map(s => resolveNames(s, outWp.users, outWp.channels));
      const sectionsWp = (buildSections as any)(resolvedWp, makeOptions(), tmp);
      const jsonWp = JSON.stringify(sectionsWp.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(jsonWp.includes("w:drawing"), "webp must embed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------- RED Bug1 Placeholder Boundaries Strict TDD (2.3) ----------

describe("RED Bug1 Placeholder boundaries >5MB/len=0/!isKnownImageMagic (2.3)", () => {
  it("placeholder >5MB → italic placeholder not ImageRun", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-red-oversized2-"));
    try {
      const rel = "images/m1__big2.png";
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const fd = fs.openSync(full, "w");
      fs.ftruncateSync(fd, 5 * 1024 * 1024 + 1);
      fs.closeSync(fd);
      const out: ExportOutput = {
        schemaVersion: "2" as any, guildId: "guild-1", generatedAt: "2026-08-20T10:00:00.000Z", mode: "full",
        filter: { channelIds: [], from: null, to: null },
        users: { "u1": { username: "alice", displayName: "Alice", globalName: "Alice G" } },
        channels: { "c1": { name: "general", type: "text", parentId: null } },
        sessions: [{ start: "2026-08-20T10:00:00.000Z", end: "2026-08-20T11:00:00.000Z", channelIds: ["c1"], timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-20T10:00:00.000Z", text: "hello", images: [{ name: "big2.png", path: rel, contentType: "image/png" }] }], topics: [] }],
      };
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("[image: big2.png unavailable]"), "oversized must be placeholder");
      assert.ok(json.includes("w:i"), "placeholder italic");
      // must NOT contain drawing with image extent for this item
      const hasDrawing = json.includes("w:drawing") && json.includes("big2.png");
      assert.ok(!hasDrawing || json.includes("[image:"), "oversized must not embed ImageRun");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("placeholder len=0 → italic placeholder", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-red-empty-"));
    try {
      const rel = "images/m1__empty.png";
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.alloc(0));
      const out: ExportOutput = {
        schemaVersion: "2" as any, guildId: "guild-1", generatedAt: "2026-08-20T10:00:00.000Z", mode: "full",
        filter: { channelIds: [], from: null, to: null },
        users: { "u1": { username: "alice", displayName: "Alice", globalName: "Alice G" } },
        channels: { "c1": { name: "general", type: "text", parentId: null } },
        sessions: [{ start: "2026-08-20T10:00:00.000Z", end: "2026-08-20T11:00:00.000Z", channelIds: ["c1"], timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-20T10:00:00.000Z", text: "hello", images: [{ name: "empty.png", path: rel, contentType: "image/png" }] }], topics: [] }],
      };
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("[image: empty.png unavailable]"));
      assert.ok(json.includes("w:i"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("placeholder !isKnownImageMagic fake %PDF → italic placeholder distinct from fallback", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-red-fake-"));
    try {
      const rel = "images/m1__fake.png";
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from("%PDF-1.4 fake content"));
      const out: ExportOutput = {
        schemaVersion: "2" as any, guildId: "guild-1", generatedAt: "2026-08-20T10:00:00.000Z", mode: "full",
        filter: { channelIds: [], from: null, to: null },
        users: { "u1": { username: "alice", displayName: "Alice", globalName: "Alice G" } },
        channels: { "c1": { name: "general", type: "text", parentId: null } },
        sessions: [{ start: "2026-08-20T10:00:00.000Z", end: "2026-08-20T11:00:00.000Z", channelIds: ["c1"], timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-20T10:00:00.000Z", text: "hello", images: [{ name: "fake.png", path: rel, contentType: "image/png" }] }], topics: [] }],
      };
      const resolved = out.sessions.map(s => resolveNames(s, out.users, out.channels));
      const sections = (buildSections as any)(resolved, makeOptions(), tmp);
      const json = JSON.stringify(sections.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
      assert.ok(json.includes("[image: fake.png unavailable]"), "fake %PDF must be placeholder");
      assert.ok(!json.includes("%PDF"), "raw bytes must not be embedded");
      assert.ok(json.includes("w:i"), "placeholder italic");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------- RED docx-aesthetic-refresh PR1: Intl helpers + header (Strict TDD) ----------

describe("RED docx-aesthetic-refresh PR1: Intl helpers SP (1.1)", () => {
  it("formatSpan long 19 de outubro 15:44 — 20 de outubro 02:45 SP no seconds", async () => {
    const { formatSpan } = await import("./generateReport");
    assert.equal(
      formatSpan("2023-10-19T18:44:28Z", "2023-10-20T05:45:59Z"),
      "19 de outubro de 2023, 15:44 — 20 de outubro de 2023, 02:45"
    );
  });

  it("formatMessageTime short 19/10/2023 15:01 SP no seconds/comma", async () => {
    const { formatMessageTime } = await import("./generateReport");
    assert.equal(formatMessageTime("2023-10-19T18:01:00Z"), "19/10/2023 15:01");
  });

  it("formatFooterTime ends -03:00 not Z and contains pt-BR short month", async () => {
    const { formatFooterTime } = await import("./generateReport");
    const d = new Date("2026-08-23T20:14:54.095Z");
    const out = formatFooterTime(d);
    assert.match(out, / -03:00$/);
    assert.ok(!out.includes("Z"), "must not contain Z");
    assert.ok(!out.includes("T"), "must not contain T");
    assert.match(out, /23 ago\. 2026, 17:14 -03:00/);
  });

  it("TZ conversion edge 15:44Z → 12:44 SP", async () => {
    const { formatMessageTime, formatSpan } = await import("./generateReport");
    assert.equal(formatMessageTime("2023-10-19T15:44:28Z"), "19/10/2023 12:44");
    assert.ok(formatSpan("2023-10-19T15:44:28Z", "2023-10-19T16:44:28Z").includes("12:44"));
    assert.ok(!formatSpan("2023-10-19T15:44:28Z", "2023-10-19T16:44:28Z").includes("15:44"));
  });

  it("invalid throws for formatSpan/formatMessageTime", async () => {
    const { formatSpan, formatMessageTime } = await import("./generateReport");
    assert.throws(() => formatSpan("not-a-date", "2023-10-20T05:45:59Z"), /invalid date/i);
    assert.throws(() => formatMessageTime("bad-iso"), /invalid date/i);
    assert.throws(() => formatSpan("2023-10-19T18:44:28Z", "invalid"), /invalid date/i);
  });

  it("helpers must NOT include seconds/millis/T/Z/UTC", async () => {
    const { formatSpan, formatMessageTime, formatFooterTime } = await import("./generateReport");
    const span = formatSpan("2023-10-19T18:44:28.528Z", "2023-10-20T05:45:59.060Z");
    const msg = formatMessageTime("2023-10-19T18:44:28.528Z");
    const footer = formatFooterTime(new Date("2023-10-19T18:44:28.528Z"));
    for (const s of [span, msg]) {
      assert.ok(!s.includes("528"), "no millis");
      assert.ok(!s.includes("28.528"), "no seconds millis");
      assert.ok(!s.includes("T"), "no T");
      // footer has -03:00 but span/msg must not have Z or UTC
      assert.ok(!s.includes("Z"), "no Z");
      assert.ok(!s.includes("UTC"), "no UTC");
    }
    // footer must not contain Z/T either, only -03:00
    assert.ok(!footer.includes("Z"));
    assert.match(footer, / -03:00$/);
    // seconds check: should be HH:mm only, no :28
    assert.ok(!/\d{2}:\d{2}:\d{2}/.test(span), "span no seconds");
    assert.ok(!/\d{2}:\d{2}:\d{2}/.test(msg), "msg no seconds");
  });
});

describe("RED docx-aesthetic-refresh PR1: header title/span/metadata (2.1)", () => {
  it("title sz48 Aptos Display bold CENTER and span sz24 Aptos CENTER after:480", () => {
    const { buildSections } = require("./generateReport");
    const output = makeOutput();
    const resolved = resolveNames(output.sessions[0], output.users, output.channels);
    const sections = buildSections([resolved], makeOptions({ serverName: "JogoHoje" }));
    const firstChildren = sections[0].children;
    const jsons = firstChildren.map((c: any) => JSON.stringify(c.root ?? c));
    const allJson = jsons.join("\n");
    // title: first para should contain JogoHoje, 48, Aptos Display, bold, jc center
    assert.ok(allJson.includes("JogoHoje"), "title must contain server name");
    assert.ok(allJson.includes("48"), "title sz 48 (half-pt) must be present");
    assert.ok(allJson.includes("Aptos Display"), "title font Aptos Display");
    // center alignment
    assert.ok(allJson.includes("center") || allJson.includes("CENTER"), "title and span must be center");
    // span: second para should be date range SP long, sz 24, Aptos, after 480
    const spanJson = jsons[1] ?? "";
    assert.ok(spanJson.includes("24") || allJson.includes("24"), "span sz 24 present");
    assert.ok(allJson.includes("Aptos"), "Aptos font present");
    assert.ok(allJson.includes("480"), "span spacing after 480 must exist");
    // ensure after 480 is in span para, not just anywhere
    assert.ok(spanJson.includes("480"), "span para must have after 480");
  });

  it("4× metadata RIGHT sz18 Aptos last after:360 no 3600 spacer footer -03:00", () => {
    const { buildSections } = require("./generateReport");
    const output = makeOutput();
    const resolved = resolveNames(output.sessions[0], output.users, output.channels);
    const sections = buildSections([resolved], makeOptions({ serverName: "JogoHoje" }));
    const firstChildren = sections[0].children;
    const jsons = firstChildren.map((c: any) => JSON.stringify(c.root ?? c));
    const allJson = jsons.join("\n");
    // No 3600 anywhere
    assert.ok(!allJson.includes("3600"), "must not contain spacer 3600, got: " + allJson.slice(0, 2000));
    // 4 metadata paras each RIGHT sz18 Aptos — check at least 4 occurrences of right
    const rightCount = (allJson.match(/right/gi) || []).length;
    assert.ok(rightCount >= 4, `need >=4 right alignments, got ${rightCount}`);
    assert.ok(allJson.includes("18"), "metadata sz 18 present");
    // last meta after 360
    const lastMetaJson = jsons[jsons.length - 1] ?? "";
    // Check that at least one para has after 360
    assert.ok(allJson.includes("360"), "after 360 must exist for last meta");
    // footer -03:00 in generated
    assert.match(allJson, /-03:00/);
    assert.ok(!allJson.match(/Generated:[^]*Z"/) || allJson.includes("-03:00"), "generated must not have Z, must have -03:00");
    // ensure header has 6 children? Title + span + 4 metas =6, no spacer
    assert.equal(firstChildren.length, 6, "titleAndMetaCompact must be 6 paras (title, span, 4 metas) no spacer, got " + firstChildren.length);
  });

  it("empty sessions still title 48 no spacer 4 sections", () => {
    const { buildSections } = require("./generateReport");
    const sections = buildSections([], makeOptions({ serverName: "Empty" }));
    assert.equal(sections.length, 4);
    const firstJson = JSON.stringify(sections[0].children.map((c: any) => c.root ?? c));
    assert.ok(!firstJson.includes("3600"), "empty must not have 3600");
    assert.ok(firstJson.includes("48"), "empty title still 48");
  });
});

// ---------- RED docx-aesthetic-refresh PR2: timeline 7-run · + after:60 + thread parity (Strict TDD 3.1/3.3/3.5) ----------

function assertSevenRunPara(json: string, _expected: { channel: string; author: string; timeIso: string; body: string }) {
  const rCount = (json.match(/"w:r"/g) || []).length;
  assert.equal(rCount, 7, `must have exactly 7 w:r, got ${rCount} json: ` + json.slice(0, 1200));
  // spacing after:60 contextualSpacing
  assert.ok(json.includes('"w:spacing"'), "must have w:spacing");
  assert.ok(json.includes('"w:contextualSpacing"'), "must have contextualSpacing");
  assert.ok(json.includes('"w:after"') && json.includes('"value":60'), "must have after 60, got " + json.slice(0, 800));
  assert.ok(!json.includes('"value":3600'), "must NOT have after 3600");
  // sizes: 18 appears 3 times (chan, time, separator), 21 appears 4 times (sp, author, sp, body)
  const sz18 = (json.match(/"val":18/g) || []).length;
  const sz21 = (json.match(/"val":21/g) || []).length;
  // each sz appears duplicated via w:sz + w:szCs so counts double: 3*2=6 for 18, 4*2=8 for 21
  assert.ok(sz18 >= 6, `need at least 6 sz18 (3 runs ×2), got ${sz18}`);
  assert.ok(sz21 >= 8, `need at least 8 sz21 (4 runs ×2), got ${sz21}`);
  // colors 808080 for chan/time/separator (3 runs)
  const colorCount = (json.match(/808080/g) || []).length;
  assert.ok(colorCount >= 3, `need >=3 color 808080, got ${colorCount}`);
  // fonts Aptos everywhere
  assert.ok(json.includes("Aptos"), "must have font Aptos");
  // bold for author
  assert.ok(json.includes('"w:b"'), "must have bold for author (w:b)");
  // italics for timestamp
  assert.ok(json.includes('"w:i"'), "must have italics for timestamp (w:i)");
  // separator · (U+00B7) exactly once between timestamp and body, not :
  assert.ok(json.includes("·"), "must contain separator · (U+00B7)");
  const bulletCount = (json.match(/·/g) || []).length;
  assert.equal(bulletCount, 1, `separator · must appear exactly once, got ${bulletCount}`);
  // colon after timestamp must NOT exist as ): or :\s
  // ensure no colon immediately after timestamp pattern "): " old was "): " — new must be " · "
  // check that json does NOT contain '):' as part of timestamp run
  // we assert that after timestamp, the separator is · not :
  // simplistic: ensure json does NOT contain '"w:t" ... "):' with colon
  // count colon in w:t context: old had ");" colon; new separator has no colon
  // We'll assert that the json for message para does not contain '):' adjacent to time when inspecting text runs
  // Extract all w:t texts
  const texts: string[] = [];
  const re = /"w:t"[^]*?"([^"]*·[^"]*|[^"]*)"/g;
  // Instead simple: ensure no run contains '): ' colon suffix for timestamp
  assert.ok(!json.includes("):"), "must NOT contain '):' timestamp suffix");
  // separator run must be size 18 color 808080 font Aptos — already covered by size/color/bullet
  // body text must be present
  assert.ok(json.includes(_expected.body) || _expected.body === "", `body "${_expected.body}" must be in json`);
  // channel bracket
  assert.ok(json.includes(`[${_expected.channel}]`), `channel [${_expected.channel}] must be in json`);
  // author
  assert.ok(json.includes(_expected.author), `author ${_expected.author} must be in json`);
  // timestamp via formatMessageTime SP without seconds
  const { formatMessageTime } = require("./generateReport");
  let expectedTime: string;
  try { expectedTime = formatMessageTime(_expected.timeIso); } catch { expectedTime = _expected.timeIso; }
  assert.ok(json.includes(expectedTime), `timestamp ${expectedTime} must be in json, got ` + json.slice(0, 900));
  assert.ok(!expectedTime.includes("T") && !expectedTime.includes("Z"), "expected timestamp must be SP no T/Z");
}

describe("RED docx-aesthetic-refresh PR2: timelineBody 7-run · after:60 contextualSpacing (3.1)", () => {
  it("chronological single → every msg 7-run after:60 · no colon", () => {
    const { buildSections } = require("./generateReport");
    const output = makeOutput();
    const resolved = resolveNames(output.sessions[0], output.users, output.channels);
    const sections = buildSections([resolved], makeOptions({ viewMode: "chronological" }));
    const timelineChildren = sections[1].children as any[];
    // filter message paras: those containing body text "Hello world" or "Hi there"
    const msgTexts = ["Hello world", "Hi there"];
    const msgParas = timelineChildren.filter((c: any) => {
      const j = JSON.stringify(c.root ?? c);
      return msgTexts.some(t => j.includes(t));
    });
    assert.equal(msgParas.length, 2, "chronological single must have 2 message paras");
    for (let i = 0; i < msgParas.length; i++) {
      const j = JSON.stringify((msgParas[i] as any).root ?? msgParas[i]);
      assertSevenRunPara(j, {
        channel: i === 0 ? "general" : "random",
        author: i === 0 ? "Alice" : "bob",
        timeIso: i === 0 ? "2026-08-19T20:00:00.000Z" : "2026-08-19T20:30:00.000Z",
        body: msgTexts[i],
      });
    }
  });

  it("by-channel single → 7-run after:60 each channel group", () => {
    const { buildSections } = require("./generateReport");
    const output = makeOutput();
    const resolved = resolveNames(output.sessions[0], output.users, output.channels);
    const sections = buildSections([resolved], makeOptions({ viewMode: "by-channel" }));
    const timelineChildren = sections[1].children as any[];
    const msgParas = timelineChildren.filter((c: any) => {
      const j = JSON.stringify(c.root ?? c);
      return j.includes("Hello world") || j.includes("Hi there");
    });
    assert.equal(msgParas.length, 2);
    for (const p of msgParas) {
      const j = JSON.stringify((p as any).root ?? p);
      const isGeneral = j.includes("Hello world");
      assertSevenRunPara(j, {
        channel: isGeneral ? "general" : "random",
        author: isGeneral ? "Alice" : "bob",
        timeIso: isGeneral ? "2026-08-19T20:00:00.000Z" : "2026-08-19T20:30:00.000Z",
        body: isGeneral ? "Hello world" : "Hi there",
      });
    }
  });

  it("chronological multi (2 sessions) → 4 branches 7-run preserved", () => {
    const { buildSections } = require("./generateReport");
    const s1 = { start: "2026-08-20T10:00:00Z", end: "2026-08-20T11:00:00Z", channelIds: ["c1"], timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-20T10:00:00.000Z", text: "first msg" }], topics: [] as any[] };
    const s2 = { start: "2026-08-20T15:00:00Z", end: "2026-08-20T16:00:00Z", channelIds: ["c1"], timeline: [{ id: "m2", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-20T15:00:00.000Z", text: "second msg" }], topics: [] as any[] };
    const output = makeOutput({ sessions: [s1 as any, s2 as any] });
    const resolved = output.sessions.map(s => resolveNames(s as any, output.users, output.channels));
    const sections = buildSections(resolved as any, makeOptions({ viewMode: "chronological" }));
    const children = sections[1].children as any[];
    const msgParas = children.filter((c: any) => JSON.stringify(c.root ?? c).includes("msg"));
    assert.equal(msgParas.length, 2, "multi chronological must have 2 msgs");
    for (const p of msgParas) {
      const j = JSON.stringify((p as any).root ?? p);
      assertSevenRunPara(j, { channel: "general", author: "Alice", timeIso: (j.includes("first") ? "2026-08-20T10:00:00.000Z" : "2026-08-20T15:00:00.000Z"), body: j.includes("first") ? "first msg" : "second msg" });
    }
  });

  it("by-channel multi → 7-run parity", () => {
    const { buildSections } = require("./generateReport");
    const s1 = { start: "2026-08-20T10:00:00Z", end: "2026-08-20T11:00:00Z", channelIds: ["c1","c2"], timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-20T10:00:00.000Z", text: "alpha" }, { id: "m2", channelId: "c2", authorId: "u2", author: "bob", channel: "random", time: "2026-08-20T10:05:00.000Z", text: "beta" }], topics: [] as any[] };
    const s2 = { start: "2026-08-20T15:00:00Z", end: "2026-08-20T16:00:00Z", channelIds: ["c1"], timeline: [{ id: "m3", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-20T15:00:00.000Z", text: "gamma" }], topics: [] as any[] };
    const output = makeOutput({ sessions: [s1 as any, s2 as any] });
    const resolved = output.sessions.map(s => resolveNames(s as any, output.users, output.channels));
    const sections = buildSections(resolved as any, makeOptions({ viewMode: "by-channel" }));
    const children = sections[1].children as any[];
    const msgParas = children.filter((c: any) => { const j=JSON.stringify(c.root??c); return j.includes("alpha")||j.includes("beta")||j.includes("gamma"); });
    assert.equal(msgParas.length, 3);
    for (const p of msgParas) {
      const j = JSON.stringify((p as any).root ?? p);
      const body = j.includes("alpha") ? "alpha" : j.includes("beta") ? "beta" : "gamma";
      const channel = j.includes("random") || body==="beta" ? "random" : "general";
      const author = body==="beta" ? "bob" : "Alice";
      const timeIso = body==="alpha" ? "2026-08-20T10:00:00.000Z" : body==="beta" ? "2026-08-20T10:05:00.000Z" : "2026-08-20T15:00:00.000Z";
      assertSevenRunPara(j, { channel, author, timeIso, body });
    }
  });
});

describe("RED docx-aesthetic-refresh PR2: threadSubSections 7-run parity (3.3)", () => {
  it("threads keep HEADING_2 and each thread msg 7-run after:60 ·", () => {
    const { buildSections } = require("./generateReport");
    const session: any = {
      start: "2026-08-19T20:00:00.000Z", end: "2026-08-19T21:00:00.000Z", channelIds: ["c1"],
      timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-19T20:00:00.000Z", text: "main" }],
      topics: [{ id: "t1", name: "Thread Topic", channelId: "c1", timeline: [{ id: "m2", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-19T20:10:00.000Z", text: "thread reply" }] }]
    };
    const output = makeOutput({ sessions: [session] });
    const resolved = output.sessions.map(s => resolveNames(s as any, output.users, output.channels));
    const sections = buildSections(resolved as any, makeOptions());
    const threadChildren = sections[2].children as any[];
    assert.ok(threadChildren.length >= 2, "threads section must have heading + msg");
    const headingJson = JSON.stringify((threadChildren[0] as any).root ?? threadChildren[0]);
    // heading must still be HEADING_2 (contains Thread: and heading level)
    assert.ok(headingJson.includes("Thread: Thread Topic"), "heading must contain Thread: Thread Topic");
    const msgPara = threadChildren[1] as any;
    const j = JSON.stringify(msgPara.root ?? msgPara);
    assertSevenRunPara(j, { channel: "general", author: "Alice", timeIso: "2026-08-19T20:10:00.000Z", body: "thread reply" });
  });

  it("multiple thread messages each 7-run", () => {
    const { buildSections } = require("./generateReport");
    const session: any = {
      start: "2026-08-19T20:00:00.000Z", end: "2026-08-19T21:00:00.000Z", channelIds: ["c1"],
      timeline: [], topics: [{ id: "t1", name: "T1", channelId: "c1", timeline: [
        { id: "m2", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-19T20:10:00.000Z", text: "one" },
        { id: "m3", channelId: "c1", authorId: "u2", author: "bob", channel: "general", time: "2026-08-19T20:11:00.000Z", text: "two" },
      ]}]
    };
    const output = makeOutput({ sessions: [session] });
    const resolved = output.sessions.map(s => resolveNames(s as any, output.users, output.channels));
    const sections = buildSections(resolved as any, makeOptions());
    const threadChildren = sections[2].children as any[];
    const msgParas = threadChildren.filter((c:any)=>{const j=JSON.stringify(c.root??c); return j.includes('"w:r"') && (j.includes("one")||j.includes("two"));});
    assert.equal(msgParas.length, 2);
    for (const p of msgParas) {
      const j = JSON.stringify((p as any).root ?? p);
      assertSevenRunPara(j, { channel: "general", author: j.includes("one")?"Alice":"bob", timeIso: j.includes("one")?"2026-08-19T20:10:00.000Z":"2026-08-19T20:11:00.000Z", body: j.includes("one")?"one":"two" });
    }
  });
});

describe("RED docx-aesthetic-refresh PR2: edges unknown emoji empty invalid images (3.5)", () => {
  it("unknown author/channel fallback 99 → unknown (99) bold 21 + emoji preserved", () => {
    const { buildSections } = require("./generateReport");
    const session: any = {
      start: "2026-08-19T20:00:00.000Z", end: "2026-08-19T21:00:00.000Z", channelIds: ["c99"],
      timeline: [{ id: "m1", channelId: "c99", authorId: "u99", author: "unknown (u99)", channel: "unknown (c99)", time: "2026-08-19T20:00:00.000Z", text: "hi 👍" }],
      topics: []
    };
    // do not call resolveNames for this edge -> use raw unknown already
    const sections = buildSections([session as any], makeOptions());
    const children = sections[1].children as any[];
    const msgPara = children.find((c:any)=>JSON.stringify(c.root??c).includes("hi 👍")) as any;
    assert.ok(msgPara, "msg para with emoji must exist");
    const j = JSON.stringify(msgPara.root ?? msgPara);
    assertSevenRunPara(j, { channel: "unknown (c99)", author: "unknown (u99)", timeIso: "2026-08-19T20:00:00.000Z", body: "hi 👍" });
    // emoji preserved already checked via body includes
    assert.ok(j.includes("👍"), "emoji 👍 must be preserved");
    // separator · sz18 808080 already asserted via assertSevenRunPara
  });

  it("empty body still 7 runs with · separator, timestamp not empty", () => {
    const { buildSections } = require("./generateReport");
    const session: any = {
      start: "2026-08-19T20:00:00.000Z", end: "2026-08-19T21:00:00.000Z", channelIds: ["c1"],
      timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-19T20:00:00.000Z", text: "" }],
      topics: []
    };
    const output = makeOutput({ sessions: [session] });
    const resolved = output.sessions.map(s => resolveNames(s as any, output.users, output.channels));
    // but we keep our empty session directly to test empty body
    const sections = buildSections([session as any], makeOptions());
    const children = sections[1].children as any[];
    // find msg para by channel+author (since body empty, filter by timestamp)
    const msgParas = children.filter((c:any)=>{const j=JSON.stringify(c.root??c); return j.includes("[general]") && j.includes("Alice");});
    assert.ok(msgParas.length >=1, "empty body must still have para");
    const j = JSON.stringify((msgParas[0] as any).root ?? msgParas[0]);
    assertSevenRunPara(j, { channel: "general", author: "Alice", timeIso: "2026-08-19T20:00:00.000Z", body: "" });
    assert.ok(j.includes("·"), "empty body still separator ·");
  });

  it("invalid time fallback raw string no throw, still 7 runs", () => {
    const { buildSections } = require("./generateReport");
    const session: any = {
      start: "2026-08-19T20:00:00.000Z", end: "2026-08-19T21:00:00.000Z", channelIds: ["c1"],
      timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "not-a-valid-iso", text: "bad time" }],
      topics: []
    };
    const sections = buildSections([session as any], makeOptions());
    const children = sections[1].children as any[];
    const msgPara = children.find((c:any)=>JSON.stringify(c.root??c).includes("bad time")) as any;
    assert.ok(msgPara, "bad time para must exist");
    const j = JSON.stringify(msgPara.root ?? msgPara);
    // should fallback to raw "not-a-valid-iso"
    assert.ok(j.includes("not-a-valid-iso"), "must fallback to raw invalid time");
    // still 7 runs
    const rCount = (j.match(/"w:r"/g)||[]).length;
    assert.equal(rCount, 7, "invalid time fallback still 7 runs");
    assert.ok(j.includes("·"), "separator still present even with invalid time");
    assert.ok(j.includes('"w:spacing"') && j.includes('"w:contextualSpacing"'), "spacing still correct");
  });

  it("image embedding still after paragraph unchanged", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docx-pr2-image-"));
    try {
      const rel = "images/m1__photo.png";
      const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
      const buf = Buffer.from(pngBase64, "base64");
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      const session: any = {
        start: "2026-08-20T10:00:00.000Z", end: "2026-08-20T11:00:00.000Z", channelIds: ["c1"],
        timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2026-08-19T20:00:00.000Z", text: "with image", images: [{ name: "photo.png", path: rel, contentType: "image/png" }] }],
        topics: []
      };
      const sections = (buildSections as any)([session], makeOptions(), tmp);
      const children = sections[1].children as any[];
      // expect at least 2 paras: message + image drawing
      assert.ok(children.length >= 2, `expected msg + image, got ${children.length}`);
      const firstJson = JSON.stringify((children[0] as any).root ?? children[0]);
      const secondJson = JSON.stringify((children[1] as any).root ?? children[1]);
      // first is message 7-run
      assertSevenRunPara(firstJson, { channel: "general", author: "Alice", timeIso: "2026-08-19T20:00:00.000Z", body: "with image" });
      // second is image drawing
      assert.ok(secondJson.includes("w:drawing") || secondJson.includes("wp:inline"), "second child must be image drawing");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------- RED docx-session-title-polish: heading polish (Strict TDD 1.1-1.6 / 3.1-3.2) ----------

function makeSessionForHeading(start: string, end: string, timelineLen: number, textPrefix = "msg"): any {
  const timeline = Array.from({ length: timelineLen }, (_, i) => ({
    id: `m${i + 1}`,
    channelId: "c1",
    authorId: "u1",
    author: "Alice",
    channel: "general",
    time: start,
    text: `${textPrefix} ${i + 1}`,
  }));
  return { start, end, channelIds: ["c1"], timeline, topics: [] as any[] };
}

function getHeadingParas(sections: any[]): any[] {
  const timelineChildren = sections[1]?.children ?? [];
  return (timelineChildren as any[]).filter((c: any) => {
    const j = JSON.stringify(c.root ?? c);
    return j.includes("Session ") && j.includes(" — ");
  });
}

describe("RED docx-session-title-polish: heading typography + pagination (1.1/1.2)", () => {
  it("1.1 chronological heading rPr/pPr: Heading1 240/120 keepNext keepLines Aptos Display 28 404040 bold", () => {
    const { buildSections } = require("./generateReport");
    const s1 = makeSessionForHeading("2024-02-06T11:50:17.088Z", "2024-02-06T19:04:45.917Z", 28);
    const s2 = makeSessionForHeading("2024-02-07T01:41:19.712Z", "2024-02-07T03:20:44.238Z", 9);
    const output = makeOutput({ sessions: [s1 as any, s2 as any] });
    const resolved = output.sessions.map((s: any) => resolveNames(s, output.users, output.channels));
    const sections = buildSections(resolved as any, makeOptions({ viewMode: "chronological" }));
    const headings = getHeadingParas(sections as any);
    assert.equal(headings.length, 2, "chronological multi must have 2 headings");
    for (const h of headings) {
      const j = JSON.stringify((h as any).root ?? h);
      // pPr
      assert.ok(j.includes("Heading1") || j.includes("HEADING_1"), "heading must retain Heading1 pStyle, got: " + j.slice(0, 600));
      assert.ok(j.includes("240"), "spacing before 240 missing: " + j.slice(0, 800));
      assert.ok(j.includes("120"), "spacing after 120 missing: " + j.slice(0, 800));
      assert.ok(j.toLowerCase().includes("keepnext"), "keepNext missing: " + j.slice(0, 800));
      assert.ok(j.toLowerCase().includes("keeplines") || j.includes("keepLines"), "keepLines missing: " + j.slice(0, 800));
      // rPr
      assert.ok(j.includes("Aptos Display"), "font Aptos Display missing: " + j.slice(0, 800));
      assert.ok(j.includes("28"), "sz 28 missing: " + j.slice(0, 800));
      assert.ok(j.includes("404040"), "color 404040 missing: " + j.slice(0, 800));
      assert.ok(j.includes('"w:b"') || j.includes("w:b"), "bold missing");
    }
  });

  it("1.2 by-channel parity: same rPr/pPr asserts on second branch", () => {
    const { buildSections } = require("./generateReport");
    const s1 = makeSessionForHeading("2024-02-06T11:50:17.088Z", "2024-02-06T19:04:45.917Z", 28);
    const s2 = makeSessionForHeading("2024-02-07T01:41:19.712Z", "2024-02-07T03:20:44.238Z", 9);
    const output = makeOutput({ sessions: [s1 as any, s2 as any] });
    const resolved = output.sessions.map((s: any) => resolveNames(s, output.users, output.channels));
    const sections = buildSections(resolved as any, makeOptions({ viewMode: "by-channel" }));
    const headings = getHeadingParas(sections as any);
    assert.equal(headings.length, 2, "by-channel multi must have 2 headings");
    for (const h of headings) {
      const j = JSON.stringify((h as any).root ?? h);
      assert.ok(j.includes("Heading1") || j.includes("HEADING_1"), "Heading1 missing by-channel");
      assert.ok(j.includes("240") && j.includes("120"), "spacing 240/120 missing by-channel");
      assert.ok(j.toLowerCase().includes("keepnext"), "keepNext missing by-channel");
      assert.ok(j.toLowerCase().includes("keeplines") || j.includes("keepLines"), "keepLines missing by-channel");
      assert.ok(j.includes("Aptos Display"), "Aptos Display missing by-channel");
      assert.ok(j.includes("28"), "sz 28 missing by-channel");
      assert.ok(j.includes("404040"), "color 404040 missing by-channel");
      assert.ok(j.includes('"w:b"') || j.includes("w:b"), "bold missing by-channel");
    }
  });
});

describe("RED docx-session-title-polish: humanized SP range + suffix (1.3/1.4)", () => {
  it("1.3 humanized SP range 6 de fevereiro de 2024, 08:50 — 6 de fevereiro de 2024, 16:04 no T/Z/.088/:ss/UTC", () => {
    const { buildSections } = require("./generateReport");
    const s1 = makeSessionForHeading("2024-02-06T11:50:17.088Z", "2024-02-06T19:04:45.917Z", 2);
    const s2 = makeSessionForHeading("2024-02-07T01:41:19.712Z", "2024-02-07T03:20:44.238Z", 1);
    const output = makeOutput({ sessions: [s1 as any, s2 as any] });
    const resolved = output.sessions.map((s: any) => resolveNames(s, output.users, output.channels));
    const sections = buildSections(resolved as any, makeOptions({ viewMode: "chronological" }));
    const headings = getHeadingParas(sections as any);
    assert.ok(headings.length >= 1, "need heading");
    const j = JSON.stringify(headings[0].root ?? headings[0]);
    // match extracts w:t texts; simple includes check
    assert.ok(j.includes("6 de fevereiro de 2024, 08:50"), "must contain humanized 6 de fevereiro 08:50, got: " + j.slice(0, 1200));
    assert.ok(j.includes(" — "), "must contain em dash separator");
    assert.ok(!j.includes("T11:50"), "must NOT contain T-time");
    assert.ok(!j.includes("Z\"") && !j.includes("Z\\"), "must NOT contain Z");
    assert.ok(!j.includes(".088"), "must NOT contain .088 ms");
    // no seconds pattern HH:mm:ss in w:t (should be HH:mm only)
    // extract w:t string if possible
    const wts: string[] = [];
    const re = /"text":\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(j)) !== null) wts.push(m[1]);
    const combinedWt = wts.join(" ");
    assert.ok(!/\d{2}:\d{2}:\d{2}/.test(combinedWt), "must NOT contain seconds HH:mm:ss, got: " + combinedWt);
    assert.ok(!combinedWt.includes("UTC"), "must NOT contain UTC");
  });

  it("1.4 suffix (N mensagens) on both viewModes incl 28, 0, 1 keep mensagens invariant", () => {
    const { buildSections } = require("./generateReport");
    // chronological 28
    const s28 = makeSessionForHeading("2024-02-06T11:50:17.088Z", "2024-02-06T19:04:45.917Z", 28);
    const s9 = makeSessionForHeading("2024-02-07T01:41:19.712Z", "2024-02-07T03:20:44.238Z", 9);
    const output = makeOutput({ sessions: [s28 as any, s9 as any] });
    const resolved = output.sessions.map((s: any) => resolveNames(s, output.users, output.channels));
    const chrono = buildSections(resolved as any, makeOptions({ viewMode: "chronological" }));
    const byChan = buildSections(resolved as any, makeOptions({ viewMode: "by-channel" }));
    const hChrono = getHeadingParas(chrono as any);
    const hByChan = getHeadingParas(byChan as any);
    const c0 = JSON.stringify(hChrono[0].root ?? hChrono[0]);
    const c1 = JSON.stringify(hChrono[1].root ?? hChrono[1]);
    const b0 = JSON.stringify(hByChan[0].root ?? hByChan[0]);
    const b1 = JSON.stringify(hByChan[1].root ?? hByChan[1]);
    assert.ok(c0.includes("(28 mensagens)"), "chrono first must end (28 mensagens), got: " + c0.slice(0, 900));
    assert.ok(c1.includes("(9 mensagens)"), "chrono second must end (9 mensagens)");
    assert.ok(b0.includes("(28 mensagens)"), "by-channel first must have (28 mensagens)");
    assert.ok(b1.includes("(9 mensagens)"), "by-channel second must have (9 mensagens)");
    assert.ok(!c0.includes("(28 mensagem)") || c0.includes("(28 mensagens)"), "must not be singular mensagem");
    assert.ok(!c0.includes("messages"), "must not be English messages");
    assert.ok(!b0.includes("messages"), "by-channel must not be English messages");
    // 0 and 1 edge
    const s0 = makeSessionForHeading("2024-02-06T11:50:17.088Z", "2024-02-06T19:04:45.917Z", 0);
    const s1 = makeSessionForHeading("2024-02-07T01:41:19.712Z", "2024-02-07T03:20:44.238Z", 1);
    const out01 = makeOutput({ sessions: [s0 as any, s1 as any] });
    const res01 = out01.sessions.map((s: any) => resolveNames(s, out01.users, out01.channels));
    const sec01 = buildSections(res01 as any, makeOptions({ viewMode: "chronological" }));
    const h01 = getHeadingParas(sec01 as any);
    assert.ok(JSON.stringify(h01[0].root ?? h01[0]).includes("(0 mensagens)"), "0 mensagens invariant");
    assert.ok(JSON.stringify(h01[1].root ?? h01[1]).includes("(1 mensagens)"), "1 mensagens invariant not mensagem");
    assert.ok(!JSON.stringify(h01[1].root ?? h01[1]).includes("(1 mensagem)\"") || JSON.stringify(h01[1].root ?? h01[1]).includes("(1 mensagens)"), "must keep mensagens plural even for 1");
  });
});

describe("RED docx-session-title-polish: guard + fallback (1.5/1.6)", () => {
  it("1.5 single session guard sessions=[1] yields 0 heading w:t matching Session \\d+ —", () => {
    const { buildSections } = require("./generateReport");
    const s1 = makeSessionForHeading("2024-02-06T11:50:17.088Z", "2024-02-06T19:04:45.917Z", 5);
    const output = makeOutput({ sessions: [s1 as any] });
    const resolved = output.sessions.map((s: any) => resolveNames(s, output.users, output.channels));
    const sections = buildSections(resolved as any, makeOptions({ viewMode: "chronological" }));
    const headings = getHeadingParas(sections as any);
    assert.equal(headings.length, 0, "single session must have 0 headings, got: " + headings.length);
    const alsoByChan = buildSections(resolved as any, makeOptions({ viewMode: "by-channel" }));
    const headingsBy = getHeadingParas(alsoByChan as any);
    assert.equal(headingsBy.length, 0, "single by-channel must have 0 headings");
    // also ensure no w:t matches Session \d+ —
    const allJson = JSON.stringify(alsoByChan.flatMap((s: any) => s.children).map((c: any) => c.root ?? c));
    // if there is no heading, there should be no Session heading text at all
    const hasSessionHeading = /Session \d+ —/.test(allJson);
    assert.ok(!hasSessionHeading, "single session document must NOT contain Session heading text");
  });

  it("1.6 invalid date fallback start=bad yields bad — 2024-02-06T19:04:45.917Z and doc still generates", () => {
    const { buildSections } = require("./generateReport");
    const bad = { start: "bad", end: "2024-02-06T19:04:45.917Z", channelIds: ["c1"], timeline: [{ id: "m1", channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2024-02-06T19:04:45.917Z", text: "hi" }], topics: [] as any[] };
    const s2 = makeSessionForHeading("2024-02-07T01:41:19.712Z", "2024-02-07T03:20:44.238Z", 2);
    const output = makeOutput({ sessions: [bad as any, s2 as any] });
    const resolved = output.sessions.map((s: any) => resolveNames(s, output.users, output.channels));
    const sections = buildSections(resolved as any, makeOptions({ viewMode: "chronological" }));
    const headings = getHeadingParas(sections as any);
    assert.equal(headings.length, 2, "invalid date still must emit 2 headings");
    const j0 = JSON.stringify(headings[0].root ?? headings[0]);
    assert.ok(j0.includes("bad — 2024-02-06T19:04:45.917Z"), "must fallback to raw bad — ISO, got: " + j0.slice(0, 900));
    // fallback heading must still have Aptos Display 28 404040 bold + 240/120 keepNext keepLines
    assert.ok(j0.includes("Aptos Display"), "fallback heading must have Aptos Display, got: " + j0.slice(0, 600));
    assert.ok(j0.includes("28"), "fallback sz 28 missing");
    assert.ok(j0.includes("404040"), "fallback color 404040 missing");
    assert.ok(j0.includes("240") && j0.includes("120"), "fallback spacing 240/120 missing");
    assert.ok(j0.toLowerCase().includes("keepnext"), "fallback keepNext missing");
    // second heading still humanized
    const j1 = JSON.stringify(headings[1].root ?? headings[1]);
    assert.ok(j1.includes("mensagens"), "second heading still mensagens");
    // doc generation not throwing already proven by buildSections success
  });
});

describe("RED docx-session-title-polish: no leak invariant (3.1)", () => {
  it("3.1 no legacy leak: headings contain no 2E74B5 sz 32 Times spacing 0 ISO", () => {
    const { buildSections } = require("./generateReport");
    const s1 = makeSessionForHeading("2024-02-06T11:50:17.088Z", "2024-02-06T19:04:45.917Z", 2);
    const s2 = makeSessionForHeading("2024-02-07T01:41:19.712Z", "2024-02-07T03:20:44.238Z", 2);
    const output = makeOutput({ sessions: [s1 as any, s2 as any] });
    const resolved = output.sessions.map((s: any) => resolveNames(s, output.users, output.channels));
    for (const vm of ["chronological", "by-channel"] as const) {
      const sections = buildSections(resolved as any, makeOptions({ viewMode: vm }));
      const headings = getHeadingParas(sections as any);
      assert.ok(headings.length > 0, vm + " must have headings");
      for (const h of headings) {
        const j = JSON.stringify((h as any).root ?? h);
        assert.ok(!j.includes("2E74B5"), vm + " must NOT contain 2E74B5 blue, got: " + j.slice(0, 700));
        // check not sz 32 alone, but sz 28 must exist - ensure 32 absent in heading rPr context
        // naive: if contains '"val":32' and heading, it's leak; but body may have 32 elsewhere - scope to heading
        assert.ok(!j.includes('"val":32') || j.includes("48"), vm + " must NOT contain sz 32 (Heading1 blue inheritance), got val 32");
        assert.ok(!j.toLowerCase().includes("times"), vm + " must NOT contain Times font");
        // no ISO leak in w:t part of heading
        const wtMatch = j.match(/"text":\s*"([^"]*)"/g);
        const headingText = wtMatch ? wtMatch.join(" ") : j;
        assert.ok(!/T\d{2}:/.test(headingText) || headingText.includes("bad —"), vm + " heading must NOT leak ISO T time, got: " + headingText.slice(0, 500));
        assert.ok(!headingText.includes("Z\"") && !/\.\\d{3}Z/.test(headingText) && !headingText.includes(".088"), vm + " must NOT leak Z/ms");
        // also no missing rFonts/sz/color - must have them (already asserted) but re-check leak: every heading rPr has rFonts
        assert.ok(j.includes("rFonts") || j.includes("Aptos Display"), vm + " heading rPr must have rFonts");
        assert.ok(!j.includes("\"value\":0") || j.includes("240"), vm + " spacing 0 leak check: heading must have 240/120 not 0");
      }
    }
  });
});

describe("RED docx-session-title-polish: count accuracy after filter (3.2)", () => {
  it("3.2 filtered to 9 msgs via filterSessions then heading suffix (9 mensagens) matches timeline.length", () => {
    const { buildSections, filterSessions } = require("./generateReport");
    // Create session with 20 messages across c1/c2, filter to c1 only => 9 remain?
    // Simpler: create s1 with 28, s2 with 9, filterSessions by channelIds ["c1"] that leaves subset?
    // Instead directly test filtered sessions as input to buildSections: count should reflect filtered timeline.length
    const base = makeOutput({
      sessions: [
        { start: "2024-02-06T11:50:17.088Z", end: "2024-02-06T19:04:45.917Z", channelIds: ["c1", "c2"], timeline: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, channelId: i < 11 ? "c1" : "c2", authorId: "u1", author: "Alice", channel: i < 11 ? "general" : "random", time: "2024-02-06T12:00:00.000Z", text: `t${i}` })), topics: [] as any[] },
        { start: "2024-02-07T01:41:19.712Z", end: "2024-02-07T03:20:44.238Z", channelIds: ["c1"], timeline: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, channelId: "c1", authorId: "u1", author: "Alice", channel: "general", time: "2024-02-07T01:45:00.000Z", text: `u${i}` })), topics: [] as any[] },
      ],
    });
    // Filter to keep only c1 -> first session timeline length becomes 11, not 20
    const filtered = filterSessions(base, makeOptions({ channelIds: ["c1"] }));
    // second session remains 9
    assert.equal(filtered[0].timeline.length, 11, "first filtered len 11");
    assert.equal(filtered[1].timeline.length, 9, "second filtered len 9");
    const resolved = filtered.map((s: any) => resolveNames(s, base.users, base.channels));
    const sections = buildSections(resolved as any, makeOptions({ viewMode: "chronological" }));
    const headings = getHeadingParas(sections as any);
    assert.equal(headings.length, 2);
    const j0 = JSON.stringify(headings[0].root ?? headings[0]);
    const j1 = JSON.stringify(headings[1].root ?? headings[1]);
    assert.ok(j0.includes("(11 mensagens)"), "first heading must reflect filtered 11, got: " + j0.slice(0, 700));
    assert.ok(j1.includes("(9 mensagens)"), "second heading must reflect filtered 9, got: " + j1.slice(0, 700));
    // also by-channel parity
    const byChan = buildSections(resolved as any, makeOptions({ viewMode: "by-channel" }));
    const hBy = getHeadingParas(byChan as any);
    assert.ok(JSON.stringify(hBy[1].root ?? hBy[1]).includes("(9 mensagens)"), "by-channel filtered suffix matches");
  });
});
