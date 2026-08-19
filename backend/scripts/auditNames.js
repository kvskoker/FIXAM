/**
 * Report -- and optionally repair -- the names already in the register.
 *
 * The validator in services/nameValidator.js stops bad names being created from
 * now on. It does nothing about the ones already there, and the pilot database
 * has plenty: "I'm John Doe", "call me John", "Wasup", "Kon3", "Tester", whole
 * questions typed into the name field. Before production those need to be seen,
 * and the ones that can be salvaged should be.
 *
 *   node scripts/auditNames.js            report only, changes nothing
 *   node scripts/auditNames.js --apply    also write the splits it is sure of
 *
 * "Sure of" means the stored name parses cleanly AND parses to the same words
 * it already contains. A name that only becomes valid by having "I'm" stripped
 * off it is reported, not rewritten: recovering "John Doe" from "I'm John Doe"
 * is a guess about a person's identity, and the right place to confirm it is a
 * conversation with them, not a batch job.
 *
 * Nothing is ever deleted, and no citizen is ever locked out. The worst
 * outcome of this script is a list on a terminal.
 */

const db = require('../db');
const nameValidator = require('../services/nameValidator');
const sanitizer = require('../services/inputSanitizer');

const APPLY = process.argv.includes('--apply');

/** Same words, same order, ignoring case and spacing? */
function isSameWords(a, b) {
    const words = (s) => String(s || '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
    return words(a) === words(b);
}

async function main() {
    const blacklist = nameValidator.mergeBlacklist(
        (await db.query("SELECT value FROM platform_settings WHERE key = 'blacklisted_names'")
            .catch(() => ({ rows: [] }))).rows[0]?.value
    );

    const { rows } = await db.query(
        'SELECT id, phone_number, name, first_name, last_name, name_verified '
        + 'FROM users ORDER BY id'
    );

    const clean = [];
    const recoverable = [];
    const bad = [];

    for (const user of rows) {
        const stored = user.name;
        if (!stored || !String(stored).trim()) {
            bad.push({ user, reason: 'empty' });
            continue;
        }

        const sanitised = sanitizer.sanitizeIdentifier(stored).text;
        const parsed = nameValidator.parseName(sanitised, { blacklist });

        if (!parsed.ok) {
            bad.push({ user, reason: parsed.reason });
        } else if (isSameWords(parsed.fullName, sanitised)) {
            clean.push({ user, parsed });
        } else {
            // Parsed only after framing was removed -- "I'm John Doe",
            // "Alhaji Ibrahim Turay". Worth a human's eye.
            recoverable.push({ user, parsed, stored: sanitised });
        }
    }

    const line = (u) => `  #${String(u.id).padEnd(5)} ${String(u.name).slice(0, 48)}`;

    console.log(`\nNames in register: ${rows.length}\n`);

    console.log(`✅ Valid as stored: ${clean.length}`);
    console.log(`⚠️  Valid only after cleaning: ${recoverable.length}`);
    for (const { user, parsed, stored } of recoverable) {
        console.log(`${line(user)}   ->  ${parsed.fullName}   (stored: "${stored}")`);
    }

    console.log(`\n❌ Cannot be salvaged: ${bad.length}`);
    const byReason = {};
    for (const entry of bad) {
        (byReason[entry.reason] = byReason[entry.reason] || []).push(entry.user);
    }
    for (const [reason, users] of Object.entries(byReason)) {
        console.log(`\n  ${reason} (${users.length}):`);
        for (const user of users) console.log(line(user));
    }

    if (!APPLY) {
        console.log('\nReport only. Re-run with --apply to write the splits for the '
            + `${clean.length} name(s) that are already valid as stored.`);
        console.log('Everything else needs a person: ask the citizen again, or correct it '
            + 'in the admin portal.\n');
        return;
    }

    let written = 0;
    for (const { user, parsed } of clean) {
        await db.query(
            'UPDATE users SET first_name = $1, last_name = $2, name_verified = TRUE, '
            + 'name = $3 WHERE id = $4',
            [parsed.firstName, parsed.lastName, parsed.fullName, user.id]
        );
        written += 1;
    }
    console.log(`\nWrote first_name/last_name for ${written} user(s).`);
    console.log(`${recoverable.length + bad.length} still need a person to look at them.\n`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Name audit failed:', err.message);
        process.exit(1);
    });
