/**
 * Repair media stored before the file's own signature was trusted.
 *
 * Uploads whose declared MIME type was missing were written with a `.bin`
 * extension and no recorded type. nginx serves those as
 * application/octet-stream, so a browser downloads the file instead of playing
 * it, and the portal had no way to tell a video from a photograph.
 *
 * This reads the first bytes of each stored file, renames it to the right
 * extension, records the type, and updates the row that points at it.
 *
 * Safe to re-run: files already carrying a correct extension and a recorded
 * type are skipped.
 *
 *   docker compose exec backend node backend/scripts/repair_media_types.js
 *   docker compose exec backend node backend/scripts/repair_media_types.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const FixamHelpers = require('../services/fixamHelpers');

const helpers = new FixamHelpers();
const UPLOADS_ROOT = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
const dryRun = process.argv.includes('--dry-run');

function diskPath(url) {
    // Stored as /uploads/issues/videos/<name>; the volume is mounted at the
    // uploads root, so everything after /uploads/ is the path within it.
    const relative = url.replace(/^\/uploads\//, '');
    return path.join(UPLOADS_ROOT, relative);
}

async function repairColumn(table, urlColumn, mimeColumn) {
    const { rows } = await db.query(
        `SELECT id, ${urlColumn} AS url${mimeColumn ? `, ${mimeColumn} AS mime` : ''}
         FROM ${table}
         WHERE ${urlColumn} IS NOT NULL`
    );

    let repaired = 0;
    let skipped = 0;
    let missing = 0;

    for (const row of rows) {
        const current = diskPath(row.url);

        if (!fs.existsSync(current)) {
            console.log(`  missing on disk: ${row.url}`);
            missing++;
            continue;
        }

        const handle = fs.openSync(current, 'r');
        const head = Buffer.alloc(64);
        fs.readSync(handle, head, 0, 64, 0);
        fs.closeSync(handle);

        const sniffed = helpers.sniffMediaType(head);
        if (!sniffed) {
            console.log(`  unrecognised signature, left alone: ${row.url}`);
            skipped++;
            continue;
        }

        const correctExt = helpers.extensionForMime(sniffed);
        const currentExt = path.extname(current).slice(1).toLowerCase();
        const needsRename = currentExt !== correctExt;
        const needsMime = mimeColumn && row.mime !== sniffed;

        if (!needsRename && !needsMime) {
            skipped++;
            continue;
        }

        let newUrl = row.url;
        if (needsRename) {
            const renamed = current.replace(/\.[^.]+$/, `.${correctExt}`);
            newUrl = row.url.replace(/\.[^.]+$/, `.${correctExt}`);
            console.log(`  ${row.url}  ->  ${newUrl}  (${sniffed})`);
            if (!dryRun) fs.renameSync(current, renamed);
        } else {
            console.log(`  ${row.url}  ->  recording type ${sniffed}`);
        }

        if (!dryRun) {
            const sets = [`${urlColumn} = $1`];
            const params = [newUrl];
            if (mimeColumn) {
                sets.push(`${mimeColumn} = $${params.length + 1}`);
                params.push(sniffed);
            }
            params.push(row.id);
            await db.query(
                `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${params.length}`,
                params
            );
        }
        repaired++;
    }

    console.log(`${table}.${urlColumn}: ${repaired} repaired, ${skipped} already correct, ${missing} missing\n`);
}

(async () => {
    console.log(dryRun ? 'Dry run — nothing will be changed.\n' : 'Repairing stored media…\n');
    try {
        await repairColumn('issues', 'image_url', 'image_mime_type');
        await repairColumn('issues', 'audio_url', null);
        await repairColumn('feedback', 'media_url', null);
        console.log('Done.');
        process.exit(0);
    } catch (err) {
        console.error('Repair failed:', err);
        process.exit(1);
    }
})();
