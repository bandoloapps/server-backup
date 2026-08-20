import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  loadAndValidate,
  filterSessions,
  resolveNames,
  computeOutputPath,
  parseReportArgs,
  type ExportOutput,
  type ReportOptions,
} from "./generateReport";

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
