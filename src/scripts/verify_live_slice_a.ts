/**
 * Live-verify (A4.1, safe fallback): run the REAL production sync path
 * (sequelize.sync({alter:true}) with the real model set, exactly as
 * src/index.ts does) against a COPY of the real server.db, then assert:
 *   - users/channels tables now exist
 *   - messages COUNT is unchanged (313)
 *   - no existing table was dropped
 * A live bot run is not feasible safely (real .env TOKEN would connect to
 * Discord and crawl a live guild), so this DB-check is the sanctioned
 * verification per the design.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { Sequelize } from "sequelize";
import { define_messages } from "../database/models/messages";
import { define_attachments } from "../database/models/attachments";
import { define_users } from "../database/models/users";
import { define_channels } from "../database/models/channels";
import { define_initial_backup_checkpoints } from "../database/models/initial_backup_checkpoints";
import { define_initial_backup_progress } from "../database/models/initial_backup_progress";

const SRC_DB = path.join(__dirname, "..", "..", "server.db");

let failed = 0;
const check = (name: string, cond: boolean) => {
    if (!cond) { failed++; console.error(`FAIL: ${name}`); }
    else { console.log(`PASS: ${name}`); }
};

const main = async () => {
    if(!fs.existsSync(SRC_DB)) { console.error("no server.db found"); process.exit(2); }

    //Copy into a private temp dir (mkdtempSync creates with 0700); chmod the copy 0600;
    //clean up in finally so the plaintext DB snapshot is never left behind.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slice-a-"));
    const COPY_DB = path.join(tempDir, "real_copy.db");
    let sequelize: Sequelize | null = null;
    try {
        fs.copyFileSync(SRC_DB, COPY_DB);
        fs.chmodSync(COPY_DB, 0o600);

        sequelize = new Sequelize({ dialect: "sqlite", storage: COPY_DB, logging: false });

        //real production model set — same registrations as src/index.ts
        const messages_model = define_messages(sequelize);
        const attachments_model = define_attachments(sequelize);
        const users_model = define_users(sequelize);
        const channels_model = define_channels(sequelize);
        const checkpoints_model = define_initial_backup_checkpoints(sequelize);
        const progress_model = define_initial_backup_progress(sequelize);

        const count_before = await messages_model.count();
        console.log(`messages before sync: ${count_before}`);

        //the exact additive sync the bot runs at startup
        await sequelize.sync({ alter: true });

        const count_after = await messages_model.count();
        check("messages COUNT unchanged after additive sync", count_after === count_before && count_before > 0);

        const tables = (await sequelize.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", { type: "SELECT" }
        )).map((r: any) => r.name);
        check("users table exists", tables.includes("users"));
        check("channels table exists", tables.includes("channels"));
        check("messages table preserved", tables.includes("messages"));
        check("attachments table preserved", tables.includes("attachments"));
        check("initial_backup_checkpoints table preserved", tables.includes("initial_backup_checkpoints"));
        check("initial_backup_progress table preserved", tables.includes("initial_backup_progress"));

        await sequelize.close();
        sequelize = null;
        console.log(failed === 0 ? "\nLIVE-DB CHECK PASSED" : `\n${failed} CHECKS FAILED`);
    } finally {
        if (sequelize) { try { await sequelize.close(); } catch {} }
        try { fs.unlinkSync(COPY_DB); } catch {}
        try { fs.rmdirSync(tempDir); } catch {}
    }
    process.exit(failed === 0 ? 0 : 1);
};

main().catch((err: any) => { console.error(err); process.exit(2); });
