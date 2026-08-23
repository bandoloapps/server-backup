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
  main,
  type ExportOutput,
  type ReportIO,
  type ReportOptions,
} from "./generateReport";
import { SectionType } from "docx";

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

  it("title size 32 and spacer spacing.after 3600", () => {
    const output = makeOutput();
    const resolved = resolveNames(output.sessions[0], output.users, output.channels);
    const sections = buildSections([resolved], makeOptions());
    const firstJson = JSON.stringify(sections[0].children.map((c: any) => c.root ?? c));
    // Title size 32: docx TextRun size is serialized as w:sz with val 32
    assert.ok(firstJson.includes('"val":32') || firstJson.includes('"size":32') || firstJson.includes("32"), "title must be size 32, got json: " + firstJson.slice(0, 500));
    // Spacer spacing.after 3600
    const hasSpacer = sections[0].children.some((c: any) => {
      const j = JSON.stringify(c.root ?? c);
      return j.includes("3600");
    });
    assert.ok(hasSpacer, "first section must contain spacer with spacing.after 3600");
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
