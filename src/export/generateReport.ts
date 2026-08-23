/**
 * DOCX session report generator.
 *
 * Reads `messages.json` output from the export pipeline and produces a
 * Google-Docs-compatible `.docx` via the `docx` npm package.
 * Pure functions for TDD; main() accepts DI for I/O.
 */
import fs from "fs";
import path from "path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  TableLayoutType,
  WidthType,
  AlignmentType,
  SectionType,
  type ISectionPropertiesOptions,
} from "docx";
import { ExportOutput, Session } from "./exportMessages";

// Re-export for consumers
export type { ExportOutput, Session } from "./exportMessages";

// ---------- types ----------

export type ViewMode = "chronological" | "by-channel";

export interface ReportOptions {
  sessionIndex: number | null;
  channelIds: string[];
  from: string | null;
  to: string | null;
  viewMode: ViewMode;
  serverName: string | null;
  output: string | null;
}

export interface ParsedReportArgs extends ReportOptions {
  inputPath: string;
}

/** A logical document section — children are docx element instances. */
export interface DocxSection {
  children: (Paragraph | Table)[];
  properties?: ISectionPropertiesOptions;
}

// ---------- constants ----------

const SUPPORTED_SCHEMA_VERSIONS = new Set(["1"]);

export const TZ = "America/Sao_Paulo" as const;

export function formatDay(isoTime: string, timeZone: string): string {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${isoTime}`);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

export function groupSessionsByDay(
  sessions: Session[],
  timeZone: string
): Map<string, Session[]> {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const rawIso =
      s.start && s.start.trim() !== "" ? s.start : (s.timeline[0]?.time ?? "");
    if (!rawIso) continue;
    const day = formatDay(rawIso, timeZone);
    const arr = map.get(day) ?? [];
    arr.push(s);
    map.set(day, arr);
  }
  return map;
}

export function computeDailyOutputPath(
  serverName: string | null,
  day: string,
  guildId?: string | null
): string {
  const raw = serverName ?? guildId ?? "unknown";
  const sanitized = raw.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join("exports", sanitized, `daily-${day}.docx`);
}

// ---------- pure functions ----------

/**
 * Parse and validate a JSON string into an ExportOutput.
 * Throws on malformed JSON or unsupported schemaVersion.
 */
export function loadAndValidate(jsonString: string): ExportOutput {
  let data: unknown;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error("invalid JSON: could not parse input");
  }

  if (data == null || typeof data !== "object") {
    throw new Error("invalid input: expected a JSON object");
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.schemaVersion !== "string") {
    throw new Error(
      "missing or invalid schemaVersion: expected a string"
    );
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.has(obj.schemaVersion)) {
    throw new Error(
      `unsupported schema version '${obj.schemaVersion}'; supported: ${[...SUPPORTED_SCHEMA_VERSIONS].join(", ")}`
    );
  }

  return data as ExportOutput;
}

/**
 * Filter sessions by index, channel IDs, and time window.
 * Zero matches returns an empty array (not an error — D2).
 */
export function filterSessions(
  output: ExportOutput,
  options: ReportOptions
): Session[] {
  let sessions = [...output.sessions];

  // Filter by session index
  if (options.sessionIndex !== null) {
    if (options.sessionIndex >= 0 && options.sessionIndex < sessions.length) {
      sessions = [sessions[options.sessionIndex]];
    } else {
      return [];
    }
  }

  // Filter by channels and time window within each session
  if (
    options.channelIds.length > 0 ||
    options.from !== null ||
    options.to !== null
  ) {
    const channelSet =
      options.channelIds.length > 0
        ? new Set(options.channelIds)
        : null;
    const fromMs = options.from != null ? new Date(options.from).getTime() : null;
    const toMs = options.to != null ? new Date(options.to).getTime() : null;

    sessions = sessions
      .map((session) => {
        const filtered = session.timeline.filter((entry) => {
          if (channelSet && !channelSet.has(entry.channelId)) return false;
          const entryMs = new Date(entry.time).getTime();
          if (fromMs != null && entryMs < fromMs) return false;
          if (toMs != null && entryMs > toMs) return false;
          return true;
        });
        return { ...session, timeline: filtered };
      })
      .filter((session) => session.timeline.length > 0);
  }

  return sessions;
}

/**
 * Resolve author and channel names via the users/channels maps.
 * Unresolved IDs fall back to "unknown (<id>)".
 * Emoji is preserved as Unicode text (no transformation).
 */
export function resolveNames(
  session: Session,
  users: ExportOutput["users"],
  channels: ExportOutput["channels"]
): Session {
  const resolveUser = (id: string): string => {
    const u = users[id];
    return u?.displayName ?? u?.username ?? u?.globalName ?? `unknown (${id})`;
  };

  const resolveChannel = (id: string): string => {
    const c = channels[id];
    return c?.name ?? `unknown (${id})`;
  };

  const resolveTimeline = (entries: Session["timeline"]) =>
    entries.map((e) => ({
      ...e,
      author: resolveUser(e.authorId),
      channel: resolveChannel(e.channelId),
    }));

  return {
    ...session,
    timeline: resolveTimeline(session.timeline),
    topics: session.topics.map((t) => ({
      ...t,
      timeline: resolveTimeline(t.timeline),
    })),
  };
}

/**
 * Compute the default output path for a session report.
 *
 * Slug format: YYYY-MM-DD_HHmm from the session's first message timestamp (D1).
 * Default: ./exports/<server-name>/<slug>/session-<slug>.docx
 * --output overrides the entire path.
 */
export function computeOutputPath(
  options: ReportOptions,
  session: Session,
  guildId?: string | null
): string {
  if (options.output) {
    return options.output;
  }

  const serverName = options.serverName ?? guildId ?? "unknown";
  const firstTime = session.timeline.length > 0
    ? session.timeline[0].time
    : session.start;
  const slug = formatSlug(firstTime);

  return path.join("exports", serverName, slug, `session-${slug}.docx`);
}

/**
 * Parse CLI arguments into ParsedReportArgs.
 * Throws on unknown flags or missing values.
 */
export function parseReportArgs(argv: string[]): ParsedReportArgs {
  const out: ParsedReportArgs = {
    sessionIndex: null,
    channelIds: [],
    from: null,
    to: null,
    viewMode: "chronological",
    serverName: null,
    output: null,
    inputPath: "export/messages.json",
  };

  const nextValue = (
    i: number,
    eq: number,
    flag: string
  ): { value: string; next: number } => {
    if (eq >= 0) return { value: argv[i].slice(eq + 1), next: i };
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    return { value, next: i + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    switch (name) {
      case "--session": {
        const v = nextValue(i, eq, "--session");
        const n = Number(v.value);
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
          throw new Error(`invalid --session value: '${v.value}'`);
        }
        out.sessionIndex = n;
        i = v.next;
        break;
      }
      case "--channels": {
        const v = nextValue(i, eq, "--channels");
        out.channelIds = v.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i = v.next;
        break;
      }
      case "--from": {
        const v = nextValue(i, eq, "--from");
        out.from = v.value;
        i = v.next;
        break;
      }
      case "--to": {
        const v = nextValue(i, eq, "--to");
        out.to = v.value;
        i = v.next;
        break;
      }
      case "--view": {
        const v = nextValue(i, eq, "--view");
        if (v.value !== "chronological" && v.value !== "by-channel") {
          throw new Error(
            `invalid --view value: '${v.value}' (expected 'chronological' or 'by-channel')`
          );
        }
        out.viewMode = v.value;
        i = v.next;
        break;
      }
      case "--server-name": {
        const v = nextValue(i, eq, "--server-name");
        out.serverName = v.value;
        i = v.next;
        break;
      }
      case "--output": {
        const v = nextValue(i, eq, "--output");
        out.output = v.value;
        i = v.next;
        break;
      }
      case "--input": {
        const v = nextValue(i, eq, "--input");
        out.inputPath = v.value;
        i = v.next;
        break;
      }
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return out;
}

// ---------- helpers ----------

/**
 * Format an ISO-8601 timestamp as YYYY-MM-DD_HHmm (UTC).
 */
function formatSlug(isoTime: string): string {
  const d = new Date(isoTime);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}${min}`;
}

// ---------- section helpers ----------

/**
 * Title page: server name + session span (first → last message time).
 * Size 32 for compact header (was 48).
 */
function titlePage(
  serverName: string,
  sessions: Session[]
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];

  children.push(
    new Paragraph({
      children: [new TextRun({ text: serverName, bold: true, size: 32 })],
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    })
  );

  if (sessions.length > 0) {
    const first = sessions[0].start;
    const last = sessions[sessions.length - 1].end;
    const spanText =
      sessions.length === 1
        ? `${first} — ${last}`
        : `${sessions.length} sessions: ${first} — ${last}`;
    children.push(
      new Paragraph({
        children: [new TextRun({ text: spanText, size: 24 })],
        alignment: AlignmentType.CENTER,
      })
    );
  } else {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: "No sessions", size: 24 })],
        alignment: AlignmentType.CENTER,
      })
    );
  }

  return children;
}

/**
 * Metadata: generated-at, view mode, filter description, session count.
 */
function metadata(
  generatedAt: string,
  viewMode: ViewMode,
  filterDesc: string,
  sessionCount: number
): (Paragraph | Table)[] {
  return [
    new Paragraph({
      children: [
        new TextRun({ text: "Generated: ", bold: true }),
        new TextRun(generatedAt),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "View: ", bold: true }),
        new TextRun(viewMode),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Filter: ", bold: true }),
        new TextRun(filterDesc || "none"),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Sessions: ", bold: true }),
        new TextRun(String(sessionCount)),
      ],
    }),
  ];
}

/**
 * Merged compact header: title (32) + span + spacer (after:3600) + metadata.
 * Spacer is an empty paragraph with spacing.after 3600 (~6.3cm, ~50% page).
 */
function titleAndMetaCompact(
  serverName: string,
  sessions: Session[],
  generatedAt: string,
  viewMode: ViewMode,
  filterDesc: string
): (Paragraph | Table)[] {
  const titleChildren = titlePage(serverName, sessions);
  const spacer = new Paragraph({
    children: [],
    spacing: { after: 3600 },
  });
  const metaChildren = metadata(
    generatedAt,
    viewMode,
    filterDesc,
    sessions.length
  );
  return [...titleChildren, spacer, ...metaChildren];
}

/**
 * Timeline body: messages rendered per view mode.
 * Chronological: single merged timeline sorted by (time, id).
 * By-channel: H2 per channel with that channel's messages.
 */
function timelineBody(
  sessions: Session[],
  viewMode: ViewMode
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];

  if (sessions.length === 0) {
    children.push(
      new Paragraph({ children: [new TextRun("No messages to display.")] })
    );
    return children;
  }

  // Daily grouping: when multiple sessions grouped, render per-session HEADING_1 blocks
  // so daily doc contains distinct session separators. Single session keeps prior behavior.
  if (sessions.length > 1) {
    // Chronological multi-session: sequential per-session with heading
    if (viewMode === "chronological") {
      sessions.forEach((session, idx) => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `Session ${idx + 1} — ${session.start} — ${session.end} (${session.timeline.length} messages)`,
                bold: true,
              }),
            ],
            heading: HeadingLevel.HEADING_1,
          })
        );
        const sorted = [...session.timeline].sort((a, b) => {
          const timeCmp = a.time.localeCompare(b.time);
          return timeCmp !== 0 ? timeCmp : a.id.localeCompare(b.id);
        });
        for (const entry of sorted) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: `[${entry.channel}] `, bold: true }),
                new TextRun({ text: `${entry.author} `, bold: true }),
                new TextRun({ text: `(${entry.time}): `, italics: true }),
                new TextRun(entry.text),
              ],
            })
          );
        }
      });
      return children;
    }
    // By-channel with multiple sessions: still per-session heading then by-channel inside each
    for (const [idx, session] of sessions.entries()) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `Session ${idx + 1} — ${session.start} — ${session.end}`,
              bold: true,
            }),
          ],
          heading: HeadingLevel.HEADING_1,
        })
      );
      const byChannel = new Map<string, typeof session.timeline>();
      for (const entry of session.timeline) {
        const list = byChannel.get(entry.channel) ?? [];
        list.push(entry);
        byChannel.set(entry.channel, list);
      }
      for (const [channel, entries] of byChannel) {
        entries.sort((a, b) => {
          const timeCmp = a.time.localeCompare(b.time);
          return timeCmp !== 0 ? timeCmp : a.id.localeCompare(b.id);
        });
        children.push(
          new Paragraph({
            children: [new TextRun(channel)],
            heading: HeadingLevel.HEADING_2,
          })
        );
        for (const entry of entries) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: `${entry.author} `, bold: true }),
                new TextRun({ text: `(${entry.time}): `, italics: true }),
                new TextRun(entry.text),
              ],
            })
          );
        }
      }
    }
    return children;
  }

  if (viewMode === "chronological") {
    // Merge all session timelines, sort by (time, id) — single session case
    const all = sessions.flatMap((s) => s.timeline);
    all.sort((a, b) => {
      const timeCmp = a.time.localeCompare(b.time);
      return timeCmp !== 0 ? timeCmp : a.id.localeCompare(b.id);
    });
    for (const entry of all) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `[${entry.channel}] `, bold: true }),
            new TextRun({ text: `${entry.author} `, bold: true }),
            new TextRun({ text: `(${entry.time}): `, italics: true }),
            new TextRun(entry.text),
          ],
        })
      );
    }
  } else {
    // By-channel: group messages under channel headings
    const byChannel = new Map<string, typeof sessions[0]["timeline"]>();
    for (const session of sessions) {
      for (const entry of session.timeline) {
        const list = byChannel.get(entry.channel) ?? [];
        list.push(entry);
        byChannel.set(entry.channel, list);
      }
    }
    for (const [channel, entries] of byChannel) {
      entries.sort((a, b) => {
        const timeCmp = a.time.localeCompare(b.time);
        return timeCmp !== 0 ? timeCmp : a.id.localeCompare(b.id);
      });
      children.push(
        new Paragraph({
          children: [new TextRun(channel)],
          heading: HeadingLevel.HEADING_2,
        })
      );
      for (const entry of entries) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${entry.author} `, bold: true }),
              new TextRun({ text: `(${entry.time}): `, italics: true }),
              new TextRun(entry.text),
            ],
          })
        );
      }
    }
  }

  return children;
}

/**
 * Thread sub-sections: each topic as a distinct block with heading + entries.
 */
function threadSubSections(sessions: Session[]): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const allTopics = sessions.flatMap((s) => s.topics);

  if (allTopics.length === 0) {
    return children;
  }

  for (const topic of allTopics) {
    children.push(
      new Paragraph({
        children: [new TextRun(`Thread: ${topic.name}`)],
        heading: HeadingLevel.HEADING_2,
      })
    );
    for (const entry of topic.timeline) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${entry.author} `, bold: true }),
            new TextRun({ text: `(${entry.time}): `, italics: true }),
            new TextRun(entry.text),
          ],
        })
      );
    }
  }

  return children;
}

/**
 * Participant index: unique authors with display names, rendered as a table.
 */
function participantIndex(sessions: Session[]): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const seen = new Map<string, string>(); // authorId → displayName

  for (const session of sessions) {
    for (const entry of session.timeline) {
      if (!seen.has(entry.authorId)) {
        seen.set(entry.authorId, entry.author);
      }
    }
  }

  if (seen.size === 0) {
    return children;
  }

  // Column widths must be set on EVERY cell (not just the header) and the
  // table must declare an explicit total width + fixed layout; otherwise
  // Word/Google Docs collapse the table to the narrowest cell.
  const idWidth = { size: 30, type: WidthType.PERCENTAGE };
  const nameWidth = { size: 70, type: WidthType.PERCENTAGE };

  const headerRow = new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: "Author ID", bold: true })] })],
        width: idWidth,
      }),
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: "Display Name", bold: true })] })],
        width: nameWidth,
      }),
    ],
  });

  const rows = [...seen.entries()].map(
    ([id, name]) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(id)], width: idWidth }),
          new TableCell({ children: [new Paragraph(name)], width: nameWidth }),
        ],
      })
  );

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      rows: [headerRow, ...rows],
    })
  );

  return children;
}

// ---------- buildSections ----------

/**
 * Build the four document sections from resolved sessions.
 *
 * Returns DocxSection[] in order: [titleAndMetaCompact, timelineBody,
 * threadSubSections, participantIndex]. First section merges title+metadata
 * with spacer (size 32, after:3600). Tail sections use CONTINUOUS.
 */
export function buildSections(
  sessions: Session[],
  options: ReportOptions
): DocxSection[] {
  const serverName = options.serverName ?? "Session Report";

  // Build filter description for metadata
  const filterParts: string[] = [];
  if (options.channelIds.length > 0)
    filterParts.push(`channels=${options.channelIds.join(",")}`);
  if (options.from) filterParts.push(`from=${options.from}`);
  if (options.to) filterParts.push(`to=${options.to}`);
  if (options.sessionIndex !== null)
    filterParts.push(`session=${options.sessionIndex}`);
  const filterDesc = filterParts.join("; ");

  const generatedAt = new Date().toISOString();

  return [
    {
      children: titleAndMetaCompact(
        serverName,
        sessions,
        generatedAt,
        options.viewMode,
        filterDesc
      ),
    },
    {
      children: timelineBody(sessions, options.viewMode),
      properties: { type: SectionType.CONTINUOUS },
    },
    {
      children: threadSubSections(sessions),
      properties: { type: SectionType.CONTINUOUS },
    },
    {
      children: participantIndex(sessions),
      properties: { type: SectionType.CONTINUOUS },
    },
  ];
}

// ---------- main ----------

/** I/O interface for testability — defaults to fs + process.exit (D3). */
export interface ReportIO {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: Buffer) => void;
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  exit: (code: number) => void;
}

const defaultIO: ReportIO = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc as BufferEncoding),
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  exit: (code) => process.exit(code),
};

/**
 * CLI entry point. Reads messages.json, validates, filters, renders DOCX.
 *
 * - No --session + N sessions → one DOCX per session (D1).
 * - Zero filter matches → empty DOCX + exit 0 (D2).
 */
export async function main(
  argv: string[],
  io: ReportIO = defaultIO
): Promise<void> {
  const args = parseReportArgs(argv);

  // Read and parse input
  let jsonString: string;
  try {
    jsonString = io.readFileSync(args.inputPath, "utf-8");
  } catch {
    console.error(`error: could not read ${args.inputPath}`);
    io.exit(1);
    return; // unreachable but satisfies TS
  }

  let output: ExportOutput;
  try {
    output = loadAndValidate(jsonString);
  } catch (err: any) {
    console.error(`error: ${err.message}`);
    io.exit(1);
    return;
  }

  // Filter and resolve
  const sessions = filterSessions(output, args);
  const resolved = sessions.map((s) =>
    resolveNames(s, output.users, output.channels)
  );

  // Build and write output.
  if (args.output) {
    // Single explicit --output path: one document containing all filtered sessions (bypasses grouping).
    const sections = buildSections(resolved, args);
    const doc = new Document({ sections });
    const buffer = await Packer.toBuffer(doc);
    io.mkdirSync(path.dirname(args.output), { recursive: true });
    io.writeFileSync(args.output, buffer);
  } else {
    // No --output: daily grouping via groupSessionsByDay (filters before grouping).
    if (resolved.length === 0) {
      io.exit(0);
      return;
    }
    const grouped = groupSessionsByDay(resolved, TZ);
    for (const [day, daySessions] of grouped) {
      const sections = buildSections(daySessions, args);
      const doc = new Document({ sections });
      const buffer = await Packer.toBuffer(doc);
      const outPath = computeDailyOutputPath(args.serverName, day, output.guildId);
      io.mkdirSync(path.dirname(outPath), { recursive: true });
      io.writeFileSync(outPath, buffer);
    }
  }

  io.exit(0);
}

// run only when this file is the entry point, so tests can import pure
// functions without triggering a report. realpathSync handles symlinks.
if (process.argv[1]) {
  try {
    if (fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)) {
      main(process.argv.slice(2)).catch((err: any) => {
        console.error(`report failed: ${err?.message ?? err}`);
        process.exitCode = 1;
      });
    }
  } catch {
    // process.argv[1] does not resolve: not a valid invocation of this file
  }
}
