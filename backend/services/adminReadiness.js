/**
 * Can anybody actually get in?
 *
 * With two-factor on, signing in requires a one-time code delivered over
 * WhatsApp to the administrator's own number. That makes the bootstrap account
 * a trap: SUPER_ADMIN_PHONE defaults to 23200000000, which is a syntactically
 * valid Sierra Leone number and not a real one. Nobody can receive its code.
 *
 * So the combination "2FA enabled" + "the only Admin is the bootstrap account"
 * locks every human out of the portal, and does it silently -- the login page
 * works, the password is accepted, and the code never arrives.
 *
 * This module answers the one question that prevents it: is there at least one
 * Admin whose number could plausibly receive a message?
 */

const { getServiceArea } = require('./countries');

/**
 * Could this number receive a WhatsApp message?
 *
 * A heuristic, and it only has to catch one thing: placeholder numbers. Real
 * delivery cannot be proved from a string -- the honest test is sending a code
 * and having somebody read it -- so this rejects what is obviously fake and
 * accepts everything else.
 */
function isPlausiblePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    const area = getServiceArea();

    if (!digits.startsWith(area.dialCode)) return false;
    if (digits.length !== area.phoneDigits) return false;

    // 23200000000, 23211111111 and friends. A real subscriber number is not
    // one digit repeated, and this is what the default bootstrap account is.
    const subscriber = digits.slice(area.dialCode.length);
    if (/^(\d)\1*$/.test(subscriber)) return false;

    return true;
}

/**
 * Every Admin, and whether each could receive a sign-in code.
 *
 * @returns {Promise<{
 *   admins: Array<{id, name, phone_number, is_disabled, usable}>,
 *   usable: number,
 *   ready: boolean
 * }>}
 */
async function inspectAdmins(db) {
    const result = await db.query(`
        SELECT u.id, u.name, u.phone_number, u.is_disabled,
               (u.password IS NOT NULL) AS has_password
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'Admin'
        ORDER BY u.id
    `);

    const admins = result.rows.map((row) => ({
        ...row,
        // Usable means all three: able to receive the code, able to pass the
        // password step, and not locked out.
        usable: isPlausiblePhone(row.phone_number)
            && row.has_password
            && !row.is_disabled,
    }));

    const usable = admins.filter((a) => a.usable).length;
    return { admins, usable, ready: usable > 0 };
}

/**
 * Whether two-factor can be switched on without locking everyone out, plus a
 * sentence explaining the answer.
 */
async function check2FAReadiness(db) {
    const { admins, usable, ready } = await inspectAdmins(db);

    if (ready) {
        return {
            ready: true,
            usable,
            admins,
            message: `${usable} administrator account(s) can receive a sign-in code.`,
        };
    }

    if (admins.length === 0) {
        return {
            ready: false, usable, admins,
            message: 'No account holds the Admin role. Create one before enabling 2FA.',
        };
    }

    return {
        ready: false, usable, admins,
        message: 'No administrator has a real, enabled, password-holding phone number. '
            + 'Enabling 2FA now would lock everybody out of the portal.',
    };
}

/**
 * Shout at boot if the platform is in the locked-out combination.
 *
 * Deliberately does not switch 2FA off. Quietly weakening authentication
 * because a check failed would be a worse outcome than an operator reading a
 * warning -- and the fix, granting a real administrator, takes a minute.
 */
async function warnIfLockedOut(db, twoFactorEnabled, log = console.warn) {
    if (!twoFactorEnabled) return true;

    try {
        const status = await check2FAReadiness(db);
        if (status.ready) return true;

        log('');
        log('  ****************************************************************');
        log('  *  ADMIN LOCKOUT RISK                                          *');
        log('  ****************************************************************');
        log(`  ${status.message}`);
        log('');
        log('  Two-factor authentication is ON and no administrator can receive');
        log('  a sign-in code, so the portal cannot be reached by anybody.');
        log('');
        log('  Fix it with:');
        log('    python3 backend/scripts/fixam_admin.py grant --phone 232XXXXXXXX');
        log('');
        log('  Or, to get in right now, set ADMIN_2FA_ENABLED=false, sign in,');
        log('  grant a real administrator, and switch it back on.');
        log('  ****************************************************************');
        log('');
        return false;
    } catch (err) {
        // A failed check must not stop the server booting.
        log(`Admin readiness check failed: ${err.message}`);
        return true;
    }
}

module.exports = {
    isPlausiblePhone,
    inspectAdmins,
    check2FAReadiness,
    warnIfLockedOut,
};
