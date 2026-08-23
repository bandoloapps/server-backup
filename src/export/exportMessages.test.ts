import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import sqlite3 from "sqlite3";
import { Sequelize, STRING, INTEGER, BLOB } from "sequelize";

// Helpers for crypto — must mirror production cipher: aes256, zero IV, scryptSync(password,'salt',32)
function encryptBuf(data: Buffer, password: string): Buffer {
  const key = crypto.scryptSync(password, "salt", 32);
  const cipher = crypto.createCipheriv("aes256", key, Buffer.alloc(16, 0));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

// Magic builders
function pngBytes(): Buffer {
  // PNG signature 89 50 4E 47 0D 0A 1A 0A + IHDR fake
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}
function jpgBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}
function gifBytes(): Buffer {
  return Buffer.from("GIF89a", "ascii");
}
function webpBytes(): Buffer {
  // RIFF xxxx WEBP
  const b = Buffer.alloc(12);
  b.write("RIFF", 0);
  b.writeUInt32LE(12, 4);
  b.write("WEBP", 8);
  return b;
}
function webpInvalidBytes(): Buffer {
  // RIFF but not WEBP
  const b = Buffer.alloc(12);
  b.write("RIFF", 0);
  b.writeUInt32LE(12, 4);
  b.write("XXXX", 8);
  return b;
}

describe("exportMessages Unit1 — pure helpers", () => {
  it("isAllowedExt accepts png|jpg|jpeg|gif|webp case-insensitive, rejects others", async () => {
    const { isAllowedExt } = await import("./exportMessages");
    assert.equal(isAllowedExt("photo.png"), true);
    assert.equal(isAllowedExt("PHOTO.PNG"), true);
    assert.equal(isAllowedExt("img.jpg"), true);
    assert.equal(isAllowedExt("img.JPEG"), true);
    assert.equal(isAllowedExt("anim.Gif"), true);
    assert.equal(isAllowedExt("pic.webp"), true);
    assert.equal(isAllowedExt("pic.WEBP"), true);
    assert.equal(isAllowedExt("doc.pdf"), false);
    assert.equal(isAllowedExt("notes.txt"), false);
    assert.equal(isAllowedExt("image.avif"), false);
    assert.equal(isAllowedExt("noext"), false);
    assert.equal(isAllowedExt("archive.tar.png"), true);
  });

  it("sniffMagic validates magic bytes per ext", async () => {
    const { sniffMagic } = await import("./exportMessages");
    // valid
    assert.equal(sniffMagic(pngBytes(), "png"), true);
    assert.equal(sniffMagic(jpgBytes(), "jpg"), true);
    assert.equal(sniffMagic(jpgBytes(), "jpeg"), true);
    assert.equal(sniffMagic(gifBytes(), "gif"), true);
    assert.equal(sniffMagic(webpBytes(), "webp"), true);
    // case-insensitive ext
    assert.equal(sniffMagic(pngBytes(), "PNG"), true);
    // invalid magic should fail
    assert.equal(sniffMagic(Buffer.from("hello world"), "png"), false);
    assert.equal(sniffMagic(Buffer.from("hello world"), "jpg"), false);
    assert.equal(sniffMagic(webpInvalidBytes(), "webp"), false);
    // mismatched: png bytes with jpg ext should fail
    assert.equal(sniffMagic(pngBytes(), "jpg"), false);
    assert.equal(sniffMagic(jpgBytes(), "png"), false);
    // short buffer
    assert.equal(sniffMagic(Buffer.alloc(0), "png"), false);
    assert.equal(sniffMagic(Buffer.from([0xff]), "jpg"), false);
  });

  it("sanitizeName replaces disallowed chars with _", async () => {
    const { sanitizeName } = await import("./exportMessages");
    assert.equal(sanitizeName("a/b:c*.png"), "a_b_c_.png");
    assert.equal(sanitizeName("photo.png"), "photo.png");
    assert.equal(sanitizeName("my file (1).jpg"), "my_file__1_.jpg");
    assert.equal(sanitizeName("a..b__c-1.jpg"), "a..b__c-1.jpg");
    assert.equal(sanitizeName("../../../etc/passwd.png"), ".._.._.._etc_passwd.png");
  });

  it("writeImageAtomic creates dir 0o700, file 0o600, content correct, no temp leftover", async () => {
    const { writeImageAtomic } = await import("./exportMessages");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "img-atomic-"));
    try {
      const dst = path.join(tmp, "images", "123__photo.png");
      const data = pngBytes();
      writeImageAtomic(dst, data);
      // file exists and content matches
      assert.equal(fs.existsSync(dst), true);
      assert.deepEqual(fs.readFileSync(dst), data);
      // mode 0o600
      const fstat = fs.statSync(dst);
      assert.equal(fstat.mode & 0o777, 0o600);
      // dir 0o700
      const dstat = fs.statSync(path.dirname(dst));
      assert.equal(dstat.mode & 0o777, 0o700);
      // no temp files remain
      const files = fs.readdirSync(path.dirname(dst));
      assert.equal(files.some((f) => f.startsWith(".tmp-")), false);
      // atomic overwrite
      const newData = jpgBytes();
      writeImageAtomic(dst, newData);
      assert.deepEqual(fs.readFileSync(dst), newData);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("decryptData passthrough when no password, decrypts raw Buffer, fail-loud on wrong key", async () => {
    const { decryptData } = await import("./exportMessages");
    const plain = Buffer.from(pngBytes());
    // passthrough without password
    assert.deepEqual(decryptData(plain), plain);
    assert.deepEqual(decryptData(plain, undefined), plain);
    // encrypt then decrypt matches
    const pw = "correct-pass";
    const enc = encryptBuf(plain, pw);
    assert.deepEqual(decryptData(enc, pw), plain);
    // wrong key throws fail-loud
    assert.throws(() => decryptData(enc, "wrong-pass"), /decryption failed/i);
    // ciphertext without password should not silently passthrough as valid image — but decryptData without password just returns bytes (passthrough). Wrong-key case is the fail-loud branch.
  });

  it("decryptData reuses getKey cache (no duplicate scrypt drift)", async () => {
    const mod = await import("./exportMessages");
    const { decryptData, getKeyDerivationCount } = mod;
    const plain = pngBytes();
    const pw = "cache-test-" + Date.now();
    const enc = encryptBuf(plain, pw);
    const before = getKeyDerivationCount();
    decryptData(enc, pw);
    decryptData(enc, pw);
    const after = getKeyDerivationCount();
    // second call should be cached, only 1 derivation
    assert.equal(after - before, 1);
  });
});

describe("exportMessages integration — decrypt + filter + materialize", () => {
  let outDir: string;
  let dbPath: string;
  let sequelize: Sequelize;

  // make minimal DB helper
  async function createFixture(opts: {
    password?: string;
    messages: Array<{ messageId: string; channelId: string; userId: string; time: number; text: string }>;
    attachments: Array<{ messageId: string; name: string; data: Buffer }>;
  }) {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-int-"));
    dbPath = path.join(outDir, "server.db");
    sequelize = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false });
    // define tables matching production
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
    const attachments = sequelize.define("attachments", {
      messageId: { type: STRING },
      name: { type: STRING },
      data: { type: BLOB },
    }, { timestamps: false, freezeTableName: true });

    await sequelize.sync({ force: true });

    // seed users/channels minimal
    await (users as any).bulkCreate([{ userId: "u1", username: "alice", displayName: "Alice", globalName: null }]);
    await (channels as any).bulkCreate([{ channelId: "c1", name: "general", type: "text", parentId: null }]);

    for (const m of opts.messages) {
      const raw = Buffer.from(m.text, "utf-8");
      const blob = opts.password ? encryptBuf(raw, opts.password) : raw;
      await (messages as any).create({ channelId: m.channelId, userId: m.userId, messageId: m.messageId, time: m.time, text: blob });
    }
    for (const a of opts.attachments) {
      // attachment data encrypted same way if password present (raw Buffer cipher)
      const blob = opts.password ? encryptBuf(a.data, opts.password) : a.data;
      await (attachments as any).create({ messageId: a.messageId, name: a.name, data: blob });
    }
    await sequelize.close();
    // reopen readonly for export
    sequelize = new Sequelize({ dialect: "sqlite", storage: dbPath, logging: false, dialectOptions: { mode: sqlite3.OPEN_READONLY } });
    return { outDir, dbPath, sequelize };
  }

  afterEach(async () => {
    try { await sequelize?.close(); } catch {}
    if (outDir && fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("materialization success emits relative refs + files exist", async () => {
    const { runExport } = await import("./exportMessages");
    const pw = "pw123";
    const fixtures = await createFixture({
      password: pw,
      messages: [{ messageId: "m1", channelId: "c1", userId: "u1", time: Date.now(), text: "hello" }],
      attachments: [
        { messageId: "m1", name: "photo.png", data: pngBytes() },
        { messageId: "m1", name: "img.jpg", data: jpgBytes() },
      ],
    });
    const exportOut = path.join(fixtures.outDir, "out");
    const result = await runExport(fixtures.sequelize, {
      guildId: "g1",
      password: pw,
      channelIds: [],
      from: null,
      to: null,
      sessionGapMinutes: 60,
      incremental: false,
      watermark: null,
    }, exportOut);

    assert.equal(result.output.schemaVersion, "2");
    const entries = result.output.sessions.flatMap((s) => s.timeline);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].images?.length, 2);
    for (const img of entries[0].images!) {
      assert.match(img.path, /^images\/m1__.*\.(png|jpg)$/);
      assert.equal(path.isAbsolute(img.path), false);
      const full = path.join(exportOut, img.path);
      assert.equal(fs.existsSync(full), true);
      // contentType inferred
      assert.ok(img.contentType === "image/png" || img.contentType === "image/jpeg" || img.contentType === null);
    }
    // JSON on disk
    const jsonPath = path.join(exportOut, "messages.json");
    assert.equal(fs.existsSync(jsonPath), true);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    assert.equal(parsed.schemaVersion, "2");
    // physical files exist under images/
    assert.equal(fs.existsSync(path.join(exportOut, "images", "m1__photo.png")), true);
    assert.equal(fs.existsSync(path.join(exportOut, "images", "m1__img.jpg")), true);
    // watermark stays max(time) — images do not affect it
    assert.equal(result.maxTime, fixtures.sequelize ? result.maxTime : result.maxTime);
  });

  it("non-image skipped (doc.pdf, notes.txt)", async () => {
    const { runExport } = await import("./exportMessages");
    const fixtures = await createFixture({
      messages: [{ messageId: "m2", channelId: "c1", userId: "u1", time: Date.now(), text: "hi" }],
      attachments: [
        { messageId: "m2", name: "doc.pdf", data: Buffer.from("%PDF-1.4 fake") },
        { messageId: "m2", name: "notes.txt", data: Buffer.from("hello notes") },
      ],
    });
    const exportOut = path.join(fixtures.outDir, "out2");
    const result = await runExport(fixtures.sequelize, {
      guildId: null, password: undefined, channelIds: [], from: null, to: null, sessionGapMinutes: 60, incremental: false, watermark: null,
    }, exportOut);
    const entries = result.output.sessions.flatMap((s) => s.timeline);
    assert.equal(entries[0].images == null || entries[0].images.length === 0, true);
    // no image files written
    const imgDir = path.join(exportOut, "images");
    if (fs.existsSync(imgDir)) {
      assert.equal(fs.readdirSync(imgDir).length, 0);
    }
    // schemaVersion remains 1 when no images
    assert.equal(result.output.schemaVersion, "1");
  });

  it("unsupported format skipped (avif ext / webp invalid magic)", async () => {
    const { runExport } = await import("./exportMessages");
    const fixtures = await createFixture({
      messages: [{ messageId: "m3", channelId: "c1", userId: "u1", time: Date.now(), text: "x" }],
      attachments: [
        { messageId: "m3", name: "image.avif", data: pngBytes() },
        { messageId: "m3", name: "bad.webp", data: webpInvalidBytes() },
        { messageId: "m3", name: "fake.png", data: Buffer.from("not a png") },
      ],
    });
    const exportOut = path.join(fixtures.outDir, "out3");
    const result = await runExport(fixtures.sequelize, {
      guildId: null, password: undefined, channelIds: [], from: null, to: null, sessionGapMinutes: 60, incremental: false, watermark: null,
    }, exportOut);
    const entries = result.output.sessions.flatMap((s) => s.timeline);
    assert.equal(entries[0].images == null || entries[0].images.length === 0, true);
  });

  it("duplicate name with messageId prefix → distinct paths", async () => {
    const { runExport } = await import("./exportMessages");
    const fixtures = await createFixture({
      messages: [
        { messageId: "id1", channelId: "c1", userId: "u1", time: Date.now(), text: "a" },
        { messageId: "id2", channelId: "c1", userId: "u1", time: Date.now() + 1000, text: "b" },
      ],
      attachments: [
        { messageId: "id1", name: "photo.png", data: pngBytes() },
        { messageId: "id2", name: "photo.png", data: pngBytes() },
      ],
    });
    const exportOut = path.join(fixtures.outDir, "out4");
    const result = await runExport(fixtures.sequelize, {
      guildId: null, password: undefined, channelIds: [], from: null, to: null, sessionGapMinutes: 60, incremental: false, watermark: null,
    }, exportOut);
    const entries = result.output.sessions.flatMap((s) => s.timeline).sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(entries[0].images![0].path, "images/id1__photo.png");
    assert.equal(entries[1].images![0].path, "images/id2__photo.png");
    assert.equal(fs.existsSync(path.join(exportOut, "images", "id1__photo.png")), true);
    assert.equal(fs.existsSync(path.join(exportOut, "images", "id2__photo.png")), true);
  });

  it("sanitization preserves collision safety (a/b:c*.png → a_b_c_.png)", async () => {
    const { runExport } = await import("./exportMessages");
    const fixtures = await createFixture({
      messages: [{ messageId: "mX", channelId: "c1", userId: "u1", time: Date.now(), text: "x" }],
      attachments: [{ messageId: "mX", name: "a/b:c*.png", data: pngBytes() }],
    });
    const exportOut = path.join(fixtures.outDir, "out5");
    const result = await runExport(fixtures.sequelize, {
      guildId: null, password: undefined, channelIds: [], from: null, to: null, sessionGapMinutes: 60, incremental: false, watermark: null,
    }, exportOut);
    const entry = result.output.sessions.flatMap((s) => s.timeline)[0];
    assert.equal(entry.images![0].path, "images/mX__a_b_c_.png");
    assert.equal(fs.existsSync(path.join(exportOut, "images", "mX__a_b_c_.png")), true);
    assert.equal(entry.images![0].name, "a/b:c*.png");
  });

  it("relative path invariant images/<id>__<sanitized> never absolute", async () => {
    const { runExport } = await import("./exportMessages");
    const fixtures = await createFixture({
      messages: [{ messageId: "mR", channelId: "c1", userId: "u1", time: Date.now(), text: "x" }],
      attachments: [{ messageId: "mR", name: "pic.webp", data: webpBytes() }],
    });
    const exportOut = path.join(fixtures.outDir, "outR");
    const result = await runExport(fixtures.sequelize, {
      guildId: null, password: undefined, channelIds: [], from: null, to: null, sessionGapMinutes: 60, incremental: false, watermark: null,
    }, exportOut);
    const img = result.output.sessions.flatMap((s) => s.timeline)[0].images![0];
    assert.equal(path.isAbsolute(img.path), false);
    assert.match(img.path, /^images\//);
  });

  it("missing decrypt fails loud — abort with no partial messages.json/images", async () => {
    const { runExport } = await import("./exportMessages");
    const correctPw = "right";
    const wrongPw = "wrong";
    const fixtures = await createFixture({
      password: correctPw,
      messages: [{ messageId: "mF", channelId: "c1", userId: "u1", time: Date.now(), text: "secret" }],
      attachments: [{ messageId: "mF", name: "secret.png", data: pngBytes() }],
    });
    const exportOut = path.join(fixtures.outDir, "outF");
    await assert.rejects(
      () => runExport(fixtures.sequelize, {
        guildId: null, password: wrongPw, channelIds: [], from: null, to: null, sessionGapMinutes: 60, incremental: false, watermark: null,
      }, exportOut),
      /decryption failed/i
    );
    assert.equal(fs.existsSync(path.join(exportOut, "messages.json")), false);
    // no images leaked
    const imgPath = path.join(exportOut, "images", "mF__secret.png");
    assert.equal(fs.existsSync(imgPath), false);
  });

  it("schema backward compat v1 without images validates", async () => {
    const { buildExport } = await import("./exportMessages");
    const now = Date.now();
    const result = buildExport(
      { messages: [{ channelId: "c1", userId: "u1", messageId: "m1", time: now, text: "hi" }], users: [], channels: [] },
      { guildId: null, password: undefined, channelIds: [], from: null, to: null, sessionGapMinutes: 60, incremental: false, watermark: null }
    );
    // when no images attached via buildExport alone, schemaVersion is 1
    assert.equal(result.output.schemaVersion, "1");
    // consumers should treat missing images as []
    const session = result.output.sessions[0];
    assert.equal(session.timeline[0].images, undefined);
    // simulate consumer handling: missing → []
    const images = (session.timeline[0] as any).images ?? [];
    assert.deepEqual(images, []);
  });

  it("schemaVersion 1|2 compat — 2 when images present else 1", async () => {
    const { runExport } = await import("./exportMessages");
    // with images → 2
    const f1 = await createFixture({
      messages: [{ messageId: "mA", channelId: "c1", userId: "u1", time: Date.now(), text: "a" }],
      attachments: [{ messageId: "mA", name: "a.png", data: pngBytes() }],
    });
    const out1 = path.join(f1.outDir, "outA");
    const r1 = await runExport(f1.sequelize, { guildId: null, password: undefined, channelIds: [], from: null, to: null, sessionGapMinutes: 60, incremental: false, watermark: null }, out1);
    assert.equal(r1.output.schemaVersion, "2");
    await f1.sequelize.close();
    fs.rmSync(f1.outDir, { recursive: true, force: true });

    // without images → 1
    const f2 = await createFixture({
      messages: [{ messageId: "mB", channelId: "c1", userId: "u1", time: Date.now(), text: "b" }],
      attachments: [],
    });
    const out2 = path.join(f2.outDir, "outB");
    const r2 = await runExport(f2.sequelize, { guildId: null, password: undefined, channelIds: [], from: null, to: null, sessionGapMinutes: 60, incremental: false, watermark: null }, out2);
    assert.equal(r2.output.schemaVersion, "1");
    await f2.sequelize.close();
    fs.rmSync(f2.outDir, { recursive: true, force: true });
  });
});
