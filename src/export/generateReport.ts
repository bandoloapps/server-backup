/**
 * DOCX session report generator — pure functions slice (PR 1).
 *
 * Reads `messages.json` output from the export pipeline and produces a
 * Google-Docs-compatible `.docx` via the `docx` npm package. This module
 * contains only types and pure functions (no filesystem I/O).
 *
 * PR 2 will add `buildSections`, `main()`, and the `docx` dependency.
 */
import path from "path";
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

// ---------- constants ----------

const SUPPORTED_SCHEMA_VERSIONS = new Set(["1"]);

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
