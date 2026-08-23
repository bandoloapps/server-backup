/**
 * Offline JSON exporter (Slice B, D5–D8).
 *
 * Reads server.db directly with its OWN Sequelize connection and inline model
 * definitions — never imports src/index.ts (which instantiates the Discord
 * Client at load) and never calls sequelize.sync() (strictly read-only:
 * missing tables are treated as empty caches, never created).
 *
 * Pipeline: load records -> decrypt raw BLOB bytes -> pure aggregation
 * (filters, sort, dedupe, sessions, threads-as-topics, watermark) -> write
 * export/messages.json + export/watermark.json.
 *
 * The pure functions (decryptText, resolveName, buildExport, readWatermark)
 * are exported so the fork's verify scripts can test them without a test
 * framework; main() only runs when this file is the process entry point.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import sqlite3 from "sqlite3";
import { BLOB, INTEGER, Sequelize, STRING } from "sequelize";
import { config as dotenvConfig } from "dotenv";

dotenvConfig(); // loads server-backup/.env for GUILD_ID (offline, cwd-relative)

// ---------- types ----------

export interface UserRecord {
    userId: string;
    username: string | null;
    displayName: string | null;
    globalName: string | null;
}

export interface ChannelRecord {
    channelId: string;
    name: string | null;
    type: string | null;
    parentId: string | null;
}

export interface MessageRecord {
    channelId: string;
    userId: string;
    messageId: string;
    time: number;
    text: Buffer | null;
}

export interface DecryptedMessageRecord extends Omit<MessageRecord, "text"> {
    text: string;
}

export interface ExportInput {
    messages: DecryptedMessageRecord[];
    users: UserRecord[];
    channels: ChannelRecord[];
}

export interface ExportOptions {
    guildId: string | null;
    password?: string;
    channelIds: string[];
    from: string | null;
    to: string | null;
    sessionGapMinutes: number;
    incremental: boolean;
    watermark: number | null;
}

export interface ParsedArgs {
    password?: string;
    guildId?: string;
    channelIds: string[];
    from: string | null;
    to: string | null;
    sessionGapMinutes: number;
    incremental: boolean;
    outDir: string;
}

export type SchemaVersion = "1" | "2";

export interface ExportImageRef {
    name: string;
    path: string;
    contentType: string | null;
}

export interface OutputEntry {
    id: string;
    channelId: string;
    authorId: string;
    author: string;
    channel: string;
    time: string;
    text: string;
    images?: ExportImageRef[];
}

export interface Topic {
    id: string;
    name: string;
    channelId: string;
    timeline: OutputEntry[];
}

export interface Session {
    start: string;
    end: string;
    channelIds: string[];
    timeline: OutputEntry[];
    topics: Topic[];
}

export interface ExportOutput {
    schemaVersion: SchemaVersion | string;
    guildId: string | null;
    generatedAt: string;
    mode: "full" | "incremental";
    filter: { channelIds: string[]; from: string | null; to: string | null };
    users: Record<string, { username: string | null; displayName: string | null; globalName: string | null }>;
    channels: Record<string, { name: string | null; type: string | null; parentId: string | null }>;
    sessions: Session[];
}

export interface ExportResult {
    output: ExportOutput;
    maxTime: number | null;
    emittedCount: number;
}

// ---------- decryption (D6, security spec: raw BLOB bytes, no hex decode) ----------

/**
 * Decrypt a message BLOB with the backup cipher (aes256, zero IV,
 * scryptSync(password, 'salt', 32)) and return the UTF-8 text.
 *
 * - No password -> passthrough: the DB was written unencrypted (empty key),
 *   so the stored bytes ARE the UTF-8 text.
 * - Wrong/missing key -> clear error: decipher.final() throws on the CBC
 *   padding check (ERR_OSSL_EVP_BAD_DECRYPT), and the fatal TextDecoder
 *   catches ciphertext that happens to survive as invalid UTF-8. Ciphertext
 *   is NEVER silently emitted as message text.
 */
let keyDerivationCount = 0;
const keyCache = new Map<string, Buffer>();

const deriveKey = (password: string): Buffer => {
    keyDerivationCount++;
    return crypto.scryptSync(password, "salt", 32);
};

const getKey = (password: string): Buffer => {
    let key = keyCache.get(password);
    if (key == null) {
        key = deriveKey(password);
        keyCache.set(password, key);
    }
    return key;
};

/** Test hook: number of scrypt derivations performed in this process. */
export const getKeyDerivationCount = (): number => keyDerivationCount;

export const decryptText = (blob: Buffer | null | undefined, password?: string): string => {
    if (blob == null || blob.length === 0) return "";

    let bytes: Buffer;
    if (password) {
        const key = getKey(password);
        const decipher = crypto.createDecipheriv("aes256", key, Buffer.alloc(16, 0));
        try {
            // raw BLOB bytes directly — decryptDb.js's Buffer.from(text,'hex')
            // hex decode is a known bug and MUST NOT be replicated (D6)
            bytes = Buffer.concat([decipher.update(blob), decipher.final()]);
        } catch (err: any) {
            throw new Error(
                `decryption failed: wrong or missing password (${err.code ?? err.message})`
            );
        }
    } else {
        bytes = blob;
    }

    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error(
            "decryption failed: output is not valid UTF-8 — the database appears encrypted and --password/PASSWORD is required"
        );
    }
};

// ---------- raw buffer decryption for images (same cipher as decryptText, no UTF-8) ----------

export const decryptData = (blob: Buffer | null | undefined, password?: string): Buffer => {
    if (blob == null || blob.length === 0) return Buffer.alloc(0);
    if (!password) return blob;
    const key = getKey(password);
    const decipher = crypto.createDecipheriv("aes256", key, Buffer.alloc(16, 0));
    try {
        return Buffer.concat([decipher.update(blob), decipher.final()]);
    } catch (err: any) {
        throw new Error(`decryption failed: wrong or missing password (${err.code ?? err.message})`);
    }
};

// ---------- image helpers (ext, magic, sanitize, atomic write, contentType) ----------

const ALLOWED_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export const isAllowedExt = (name: string): boolean => {
    const dot = name.lastIndexOf(".");
    if (dot < 0 || dot === name.length - 1) return false;
    const ext = name.slice(dot + 1).toLowerCase();
    return ALLOWED_EXTS.has(ext);
};

export const sniffMagic = (buf: Buffer, ext: string): boolean => {
    if (!buf || buf.length < 2) return false;
    const e = ext.replace(/^\./, "").toLowerCase();
    if (e === "png") {
        return buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    }
    if (e === "jpg" || e === "jpeg") {
        return buf[0] === 0xff && buf[1] === 0xd8;
    }
    if (e === "gif") {
        return buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
    }
    if (e === "webp") {
        if (buf.length < 12) return false;
        return buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
    }
    return false;
};

export const sanitizeName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/g, "_");

/** Truncate `${messageId}__${sanitized}` to `maxBase` (default 200) preserving ext and prefix + hash for uniqueness. */
export const truncateFileName = (messageId: string, sanitized: string, maxBase = 200): string => {
    const prefix = `${messageId}__`;
    const fileName = `${prefix}${sanitized}`;
    if (fileName.length <= maxBase) return fileName;
    const dot = sanitized.lastIndexOf(".");
    const extWithDot = dot >= 0 && dot < sanitized.length - 1 ? sanitized.slice(dot) : "";
    const stem = extWithDot ? sanitized.slice(0, -extWithDot.length) : sanitized;
    const maxStem = maxBase - prefix.length - extWithDot.length;
    if (maxStem <= 0) return `${prefix.slice(0, maxBase - extWithDot.length)}${extWithDot}`.slice(0, maxBase);
    if (stem.length <= maxStem) return `${prefix}${stem}${extWithDot}`;
    const hash = crypto.createHash("sha256").update(sanitized).digest("hex").slice(0, 8);
    if (maxStem <= hash.length + 1) {
        return `${prefix}${stem.slice(0, maxStem)}${extWithDot}`;
    }
    const keep = maxStem - hash.length - 1; // 1 for '-'
    return `${prefix}${stem.slice(0, keep)}-${hash}${extWithDot}`;
};

const extToContentType = (ext: string): string | null => {
    const e = ext.replace(/^\./, "").toLowerCase();
    if (e === "png") return "image/png";
    if (e === "jpg" || e === "jpeg") return "image/jpeg";
    if (e === "gif") return "image/gif";
    if (e === "webp") return "image/webp";
    return null;
};

export const writeImageAtomic = (dst: string, data: Buffer): void => {
    const dir = path.dirname(dst);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    const basename = path.basename(dst);
    const hash = crypto.createHash("sha256").update(basename).digest("hex").slice(0, 12);
    const tmp = path.join(dir, `.tmp-${hash}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 6)}`);
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, dst);
    try { fs.chmodSync(dst, 0o600); } catch {}
};

// ---------- name resolution (spec: unknown (<id>) fallback, never crash) ----------

export const resolveName = (id: string, names: Map<string, string>): string =>
    names.get(id) ?? `unknown (${id})`;

const buildNameMap = (
    users: UserRecord[],
    channels: ChannelRecord[]
): { userNames: Map<string, string>; channelNames: Map<string, string>; threadIds: Set<string> } => {
    const userNames = new Map<string, string>();
    for (const u of users) {
        const name = u.displayName ?? u.username ?? u.globalName;
        if (name) userNames.set(u.userId, name);
    }
    const channelNames = new Map<string, string>();
    const threadIds = new Set<string>();
    for (const c of channels) {
        if (c.name) channelNames.set(c.channelId, c.name);
        if (c.type === "thread") threadIds.add(c.channelId);
    }
    return { userNames, channelNames, threadIds };
};

// ---------- pure aggregation (B1.4–B1.7) ----------

const parseIso = (value: string, flag: string): number => {
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) {
        throw new Error(`invalid ${flag} date: '${value}' (use ISO-8601, e.g. 2024-01-01T00:00:00.000Z)`);
    }
    return ms;
};

interface InternalEntry {
    id: string;
    channelId: string;
    authorId: string;
    author: string;
    channel: string;
    time: number;
    text: string;
    images?: ExportImageRef[];
}

interface InternalTopic {
    id: string;
    name: string;
    channelId: string;
    firstMs: number;
    lastMs: number;
    entries: InternalEntry[];
}

interface InternalSession {
    startMs: number;
    endMs: number;
    channelIds: string[];
    entries: InternalEntry[];
    topics: InternalTopic[];
}

const toOutputEntry = (e: InternalEntry): OutputEntry => {
    const out: OutputEntry = {
        id: e.id,
        channelId: e.channelId,
        authorId: e.authorId,
        author: e.author,
        channel: e.channel,
        time: new Date(e.time).toISOString(), // ISO-8601 UTC — never SQL strftime
        text: e.text,
    };
    if (e.images && e.images.length > 0) out.images = e.images;
    return out;
};

export const buildExport = (input: ExportInput, options: ExportOptions): ExportResult => {
    const { userNames, channelNames, threadIds } = buildNameMap(input.users, input.channels);

    const channelFilter = new Set(options.channelIds);
    const fromMs = options.from != null ? parseIso(options.from, "--from") : null;
    const toMs = options.to != null ? parseIso(options.to, "--to") : null;

    // filter + empty-text skip + name resolution (B1.4, B1.5)
    const entries: InternalEntry[] = [];
    for (const m of input.messages) {
        if (m.text.trim().length === 0) continue; // empty/whitespace-only skipped
        if (channelFilter.size > 0 && !channelFilter.has(m.channelId)) continue;
        if (fromMs != null && m.time < fromMs) continue;
        if (toMs != null && m.time > toMs) continue;
        // incremental delta: strict > watermark (D7). Never applies in full mode.
        if (options.incremental && options.watermark != null && !(m.time > options.watermark)) continue;

        entries.push({
            id: m.messageId,
            channelId: m.channelId,
            authorId: m.userId,
            author: resolveName(m.userId, userNames),
            channel: resolveName(m.channelId, channelNames),
            time: m.time,
            text: m.text,
        });
    }

    // chronological order (time, messageId) + dedupe by messageId (B1.5)
    entries.sort(
        (a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const seen = new Set<string>();
    const unique: InternalEntry[] = [];
    for (const e of entries) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        unique.push(e);
    }

    // threads never inline (D8): separate by cached channel type
    const timeline: InternalEntry[] = [];
    const threadEntries: InternalEntry[] = [];
    for (const e of unique) {
        (threadIds.has(e.channelId) ? threadEntries : timeline).push(e);
    }

    // group threads by channelId -> topics, ordered by first-message time
    const topicMap = new Map<string, InternalEntry[]>();
    for (const e of threadEntries) {
        const group = topicMap.get(e.channelId);
        if (group) group.push(e);
        else topicMap.set(e.channelId, [e]);
    }
    const topics: InternalTopic[] = [];
    for (const [channelId, msgs] of topicMap) {
        topics.push({
            id: channelId,
            name: resolveName(channelId, channelNames),
            channelId,
            firstMs: msgs[0].time,
            lastMs: msgs[msgs.length - 1].time,
            entries: msgs,
        });
    }
    topics.sort((a, b) => a.firstMs - b.firstMs);

    // session grouping (D8): split at gaps > sessionGapMinutes*60000;
    // --from/--to forces a single session
    const gapMs = options.sessionGapMinutes * 60000;
    const singleSession = options.from != null || options.to != null;

    const sessions: InternalSession[] = [];
    if (timeline.length > 0) {
        let current: InternalSession = {
            startMs: timeline[0].time,
            endMs: timeline[0].time,
            channelIds: [timeline[0].channelId],
            entries: [timeline[0]],
            topics: [],
        };
        sessions.push(current);
        for (const e of timeline.slice(1)) {
            if (!singleSession && e.time - current.endMs > gapMs) {
                current = {
                    startMs: e.time,
                    endMs: e.time,
                    channelIds: [e.channelId],
                    entries: [e],
                    topics: [],
                };
                sessions.push(current);
            } else {
                current.entries.push(e);
                current.endMs = e.time;
                if (!current.channelIds.includes(e.channelId)) current.channelIds.push(e.channelId);
            }
        }
    } else if (topics.length > 0) {
        // threads-only DB: one synthetic session spanning the topics
        const first = Math.min(...topics.map((t) => t.firstMs));
        const last = Math.max(...topics.map((t) => t.lastMs));
        sessions.push({ startMs: first, endMs: last, channelIds: [], entries: [], topics: [] });
    }

    // attach each topic to the session whose window contains its first-message
    // time; when it falls in a gap, attach to the nearest-preceding session
    for (const t of topics) {
        let target = sessions[0];
        if (target) {
            for (const s of sessions) {
                if (s.startMs <= t.firstMs) target = s;
                else break;
            }
        }
        if (target) target.topics.push(t);
    }

    const outputSessions: Session[] = sessions.map((s) => ({
        start: new Date(s.startMs).toISOString(),
        end: new Date(s.endMs).toISOString(),
        channelIds: s.channelIds.sort(),
        timeline: s.entries.map(toOutputEntry),
        topics: s.topics.map((t) => ({
            id: t.id,
            name: t.name,
            channelId: t.channelId,
            timeline: t.entries.map(toOutputEntry),
        })),
    }));

    // watermark = max emitted time (across timeline + topics); null when empty
    let maxTime: number | null = null;
    for (const e of unique) {
        if (maxTime == null || e.time > maxTime) maxTime = e.time;
    }

    const hasImages = unique.some((e) => e.images && e.images.length > 0);
    const output: ExportOutput = {
        schemaVersion: (hasImages ? "2" : "1") as SchemaVersion,
        guildId: options.guildId,
        generatedAt: new Date().toISOString(),
        mode: options.incremental ? "incremental" : "full",
        filter: {
            channelIds: [...options.channelIds],
            from: options.from,
            to: options.to,
        },
        users: Object.fromEntries(
            input.users.map((u) => [
                u.userId,
                { username: u.username, displayName: u.displayName, globalName: u.globalName },
            ])
        ),
        channels: Object.fromEntries(
            input.channels.map((c) => [
                c.channelId,
                { name: c.name, type: c.type, parentId: c.parentId },
            ])
        ),
        sessions: outputSessions,
    };

    return { output, maxTime, emittedCount: unique.length };
};

// ---------- atomic file writes (R4-2) ----------

const writeFileAtomic = (targetPath: string, data: string): void => {
    const dir = path.dirname(targetPath);
    const tmp = path.join(dir, `.tmp-${path.basename(targetPath)}-${process.pid}-${Date.now()}`);
    // decrypted plaintext: restrict to owner read/write only
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, targetPath);
};

// ---------- watermark sidecar (B1.6, D7) ----------

export const readWatermark = (outDir: string): number | null => {
    const file = path.join(outDir, "watermark.json");
    if (!fs.existsSync(file)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { maxTime?: number | null };
        return typeof parsed.maxTime === "number" ? parsed.maxTime : null;
    } catch {
        return null; // corrupt sidecar -> start fresh rather than crash
    }
};

// ---------- offline DB read (B1.1, D5) ----------

export interface AttachmentRecord {
    messageId: string;
    name: string;
    data: Buffer | null;
}

const defineExportModels = (sequelize: Sequelize) => {
    const messages = sequelize.define("messages", {
        channelId: { type: STRING },
        userId: { type: STRING },
        messageId: { type: STRING },
        time: { type: INTEGER },
        text: { type: BLOB },
    }, { timestamps: false, freezeTableName: true });
    const users = sequelize.define("users", {
        userId: { type: STRING, primaryKey: true },
        username: { type: STRING },
        displayName: { type: STRING },
        globalName: { type: STRING },
    }, { timestamps: false, freezeTableName: true });
    const channels = sequelize.define("channels", {
        channelId: { type: STRING, primaryKey: true },
        name: { type: STRING },
        type: { type: STRING },
        parentId: { type: STRING },
    }, { timestamps: false, freezeTableName: true });
    // Inline attachments model — offline boundary, no import from models/attachments.ts
    const attachments = sequelize.define("attachments", {
        messageId: { type: STRING },
        name: { type: STRING },
        data: { type: BLOB },
    }, { timestamps: false, freezeTableName: true });
    return { messages, users, channels, attachments };
};

// no sequelize.sync(): a missing table means "empty cache", never "create it".
// Only an intentionally missing table is treated as an empty result; ANY other
// read error (e.g. a "no such column" schema drift on a healthy DB, or a
// table-level read failure) must propagate so the export fails loudly instead
// of silently writing an empty messages.json with exit 0 (data-loss risk).
const safeFindAll = async (model: any): Promise<any[]> => {
    try {
        return await model.findAll({ raw: true });
    } catch (err: any) {
        const message = String(err?.original?.message ?? err?.message ?? "");
        if (/no such table/i.test(message)) {
            return [];
        }
        throw err;
    }
};

const loadRecords = async (sequelize: Sequelize) => {
    const models = defineExportModels(sequelize);
    const [messages, users, channels, attachments] = await Promise.all([
        safeFindAll(models.messages),
        safeFindAll(models.users),
        safeFindAll(models.channels),
        safeFindAll((models as any).attachments),
    ]);
    return {
        messages: messages.map((m: any) => ({
            channelId: m.channelId as string,
            userId: m.userId as string,
            messageId: m.messageId as string,
            time: m.time as number,
            text: m.text as Buffer | null,
        })),
        users: users.map((u: any) => ({
            userId: u.userId as string,
            username: u.username as string | null,
            displayName: u.displayName as string | null,
            globalName: u.globalName as string | null,
        })),
        channels: channels.map((c: any) => ({
            channelId: c.channelId as string,
            name: c.name as string | null,
            type: c.type as string | null,
            parentId: c.parentId as string | null,
        })),
        attachments: attachments.map((a: any) => ({
            messageId: a.messageId as string,
            name: a.name as string,
            data: a.data as Buffer | null,
        })) as AttachmentRecord[],
    };
};

// ---------- image materialization (decrypt → filter → atomic write) ----------

export const decryptAndMaterializeImages = (
    attachments: AttachmentRecord[],
    password: string | undefined,
    outDir: string,
    emittedIds: Set<string>
): Map<string, ExportImageRef[]> => {
    const pending: Array<{ dst: string; data: Buffer; ref: ExportImageRef; messageId: string }> = [];
    const errors: string[] = [];
    const map = new Map<string, ExportImageRef[]>();

    for (const att of attachments) {
        if (!att.messageId || !att.name) continue;
        if (!emittedIds.has(att.messageId)) continue;
        if (!isAllowedExt(att.name)) continue;
        let raw: Buffer;
        try {
            if (att.data == null) continue;
            raw = decryptData(att.data, password);
            if (raw.length === 0) continue;
        } catch (err: any) {
            errors.push(`attachment ${att.messageId}/${att.name}: ${err.message}`);
            continue;
        }
        if (errors.length > 0) continue;
        const ext = att.name.slice(att.name.lastIndexOf(".") + 1);
        if (!sniffMagic(raw, ext)) continue;
        const sanitized = sanitizeName(att.name);
        const fileName = truncateFileName(att.messageId, sanitized, 200);
        const relPath = `images/${fileName}`;
        const dst = path.join(outDir, relPath);
        const contentType = extToContentType(ext);
        const ref: ExportImageRef = { name: att.name, path: relPath, contentType };
        pending.push({ dst, data: raw, ref, messageId: att.messageId });
    }

    if (errors.length > 0) {
        throw new Error(
            `decryption failed for ${errors.length} attachment(s) — fix the password and re-run:\n${errors.slice(0, 5).join("\n")}`
        );
    }

    // atomic writes only after all decrypts succeeded (fail-loud, no partial images)
    for (const p of pending) {
        writeImageAtomic(p.dst, p.data);
        const arr = map.get(p.messageId) ?? [];
        arr.push(p.ref);
        map.set(p.messageId, arr);
    }
    return map;
};

// ---------- orchestration (B1.2 entry: dist/export/exportMessages.js) ----------

export const runExport = async (
    sequelize: Sequelize,
    options: ExportOptions,
    outDir: string
): Promise<ExportResult> => {
    if (options.incremental && (options.channelIds.length > 0 || options.from != null || options.to != null)) {
        throw new Error(
            "--incremental cannot be combined with --channels, --from, or --to. " +
            "A filtered export would write a watermark based on a subset of messages, " +
            "causing a later unfiltered --incremental to skip never-exported messages."
        );
    }

    const { messages, users, channels, attachments } = await loadRecords(sequelize);

    // decrypt first — a single wrong/missing key aborts the whole export and
    // writes NOTHING (security spec: no ciphertext emitted as text)
    const errors: string[] = [];
    const decrypted: DecryptedMessageRecord[] = [];
    for (const m of messages) {
        try {
            decrypted.push({ ...m, text: decryptText(m.text, options.password) });
        } catch (err: any) {
            errors.push(`message ${m.messageId}: ${err.message}`);
        }
    }
    if (errors.length > 0) {
        throw new Error(
            `decryption failed for ${errors.length} message(s) — fix the password and re-run:\n${errors.slice(0, 5).join("\n")}`
        );
    }

    const result = buildExport({ messages: decrypted, users, channels }, options);

    // A filtered export must NEVER touch the watermark sidecar: its maxTime is
    // only a subset, and writing it would cause later unfiltered --incremental
    // runs to skip messages that were never exported. Only unfiltered exports
    // (full or incremental) may advance the watermark.
    const isFiltered = options.channelIds.length > 0 || options.from != null || options.to != null;

    // defensive guard: an unfiltered export whose emitted maxTime is lower than
    // the existing watermark would indicate a pruned/cleared DB. Reject before
    // writing any output so the sidecar stays intact.
    const existingWatermark = readWatermark(outDir);
    if (!isFiltered && result.maxTime != null && existingWatermark != null && result.maxTime < existingWatermark) {
        throw new Error(
            `watermark regression rejected: new maxTime (${result.maxTime}) is lower ` +
            `than the existing watermark (${existingWatermark})`
        );
    }

    // Materialize images only for emitted messages (filter respects channel/from/to/watermark)
    const emittedIds = new Set<string>();
    for (const s of result.output.sessions) {
        for (const e of s.timeline) emittedIds.add(e.id);
        for (const t of s.topics) for (const e of t.timeline) emittedIds.add(e.id);
    }

    // decrypt + filter + atomic write to <outDir>/images/<id>__<sanitized>
    // fail-loud: single attachment decrypt failure aborts with no partial messages.json/images
    let imageMap: Map<string, ExportImageRef[]> = new Map();
    if (emittedIds.size > 0 && attachments.length > 0) {
        imageMap = decryptAndMaterializeImages(attachments, options.password, outDir, emittedIds);
        // inject into output sessions (timeline + topics)
        let hasAny = false;
        for (const s of result.output.sessions) {
            for (const e of s.timeline) {
                const imgs = imageMap.get(e.id);
                if (imgs && imgs.length > 0) {
                    (e as OutputEntry).images = imgs;
                    hasAny = true;
                }
            }
            for (const t of s.topics) for (const e of t.timeline) {
                const imgs = imageMap.get(e.id);
                if (imgs && imgs.length > 0) {
                    (e as OutputEntry).images = imgs;
                    hasAny = true;
                }
            }
        }
        if (hasAny) result.output.schemaVersion = "2" as SchemaVersion;
        // if no images survived filtering, keep "1" (buildExport already set it)
    }

    // atomic writes — messages.json second, only after images succeeded
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(outDir, 0o700); } catch {}
    const messagesPath = path.join(outDir, "messages.json");
    const watermarkPath = path.join(outDir, "watermark.json");
    writeFileAtomic(messagesPath, JSON.stringify(result.output, null, 2) + "\n");
    if (!isFiltered && result.maxTime != null) {
        writeFileAtomic(watermarkPath, JSON.stringify({ maxTime: result.maxTime }, null, 2) + "\n");
    }
    return result;
};

// ---------- CLI (B1.3, B1.8) ----------

export const parseArgs = (argv: string[]): ParsedArgs => {
    const out: ParsedArgs = {
        channelIds: [],
        from: null,
        to: null,
        sessionGapMinutes: 60,
        incremental: false,
        outDir: "export",
    };
    // nextValue <i> <eq> — the value for the option at argv[i]; --flag=value
    // uses the inline part, otherwise consume the following argument.
    const nextValue = (i: number, eq: number, flag: string): { value: string; next: number } => {
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
            case "--password": {
                const v = nextValue(i, eq, "--password");
                out.password = v.value;
                i = v.next;
                break;
            }
            case "--guild": {
                const v = nextValue(i, eq, "--guild");
                out.guildId = v.value;
                i = v.next;
                break;
            }
            case "--channels": {
                const v = nextValue(i, eq, "--channels");
                out.channelIds = v.value.split(",").map((s) => s.trim()).filter(Boolean);
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
            case "--incremental": out.incremental = true; break;
            case "--session-gap-minutes": {
                const v = nextValue(i, eq, "--session-gap-minutes");
                const n = Number(v.value);
                if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --session-gap-minutes: '${v.value}'`);
                out.sessionGapMinutes = n;
                i = v.next;
                break;
            }
            case "--out": {
                const v = nextValue(i, eq, "--out");
                if (v.value.length === 0) throw new Error("--out directory path cannot be empty");
                out.outDir = v.value;
                i = v.next;
                break;
            }
            default: throw new Error(`unknown option: ${arg}`);
        }
    }
    return out;
};

export const main = async (argv: string[]): Promise<void> => {
    const args = parseArgs(argv);
    const password = args.password ?? process.env.PASSWORD;
    const guildId = args.guildId ?? process.env.GUILD_ID?.trim() ?? null;

    if (!fs.existsSync("server.db")) {
        console.error("error: server.db not found — run the bot first so server.db is created");
        process.exitCode = 1;
        return;
    }

    const outDir = path.resolve(args.outDir);
    const options: ExportOptions = {
        guildId,
        password,
        channelIds: args.channelIds,
        from: args.from,
        to: args.to,
        sessionGapMinutes: args.sessionGapMinutes,
        incremental: args.incremental,
        watermark: readWatermark(outDir),
    };

    const sequelize = new Sequelize({
        dialect: "sqlite",
        storage: "server.db",
        logging: false,
        dialectOptions: { mode: sqlite3.OPEN_READONLY },
    });
    try {
        const result = await runExport(sequelize, options, outDir);
        console.log(
            `exported ${result.emittedCount} message(s) (mode ${result.output.mode}) → ${path.join(outDir, "messages.json")}`
        );
    } finally {
        await sequelize.close();
    }
};

// run only when this file is the entry point, so verify scripts can import the
// pure functions without triggering an export. realpathSync handles symlinks
// (e.g., /Users/saff/Dev -> /Volumes/Avalonia/...), which path.resolve does not.
if (process.argv[1]) {
    try {
        if (fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)) {
            main(process.argv.slice(2)).catch((err: any) => {
                console.error(`export failed: ${err?.message ?? err}`);
                process.exitCode = 1;
            });
        }
    } catch {
        // process.argv[1] does not resolve: not a valid invocation of this file
    }
}
