const authService = require('./authService');

/**
 * Make sure the configured super admin can log in.
 *
 * The container runs `node server.js` directly -- it never runs
 * scripts/setupDb.js -- so on a fresh deployment the roles table is populated
 * by init_db.sql but no user exists at all. The login query inner-joins
 * user_roles, so the attempt fails with "Invalid credentials or access denied"
 * and there is no way in: no admin account exists to create the first admin.
 *
 * Runs on every boot and is idempotent. It will not touch an existing account's
 * password unless SUPER_ADMIN_RESET_PASSWORD is set, so a password changed
 * through the dashboard is not silently reverted on the next restart.
 */
async function ensureSuperAdmin(db, log = console.log) {
    const phone = process.env.SUPER_ADMIN_PHONE;
    const password = process.env.SUPER_ADMIN_PASSWORD;

    if (!phone || !password || phone.includes('X') || password === 'your_super_admin_password') {
        log('Super admin bootstrap skipped: SUPER_ADMIN_PHONE / SUPER_ADMIN_PASSWORD not configured.');
        return;
    }

    try {
        const roleRes = await db.query("SELECT id FROM roles WHERE name = 'Admin'");
        if (roleRes.rows.length === 0) {
            log('Super admin bootstrap skipped: Admin role missing (has init_db.sql run?).');
            return;
        }
        const adminRoleId = roleRes.rows[0].id;

        const existing = await db.query(
            'SELECT id, password FROM users WHERE phone_number = $1',
            [phone]
        );

        let userId;
        if (existing.rows.length === 0) {
            const hashed = await authService.hashPassword(password);
            const inserted = await db.query(
                `INSERT INTO users (phone_number, name, password, role_id, consent_given, consent_timestamp)
                 VALUES ($1, 'Super Admin', $2, $3, TRUE, CURRENT_TIMESTAMP)
                 RETURNING id`,
                [phone, hashed, adminRoleId]
            );
            userId = inserted.rows[0].id;
            log(`Super admin created for ${phone}.`);
        } else {
            userId = existing.rows[0].id;

            // Recover an account that cannot authenticate: no password at all,
            // or the literal "[object Promise]" an earlier bug wrote.
            const stored = existing.rows[0].password;
            const unusable = !stored || stored === '[object Promise]';

            if (unusable || process.env.SUPER_ADMIN_RESET_PASSWORD === 'true') {
                const hashed = await authService.hashPassword(password);
                await db.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, userId]);
                log(`Super admin password reset for ${phone}.`);
            }
        }

        // The login query joins user_roles; role_id on the user alone is not
        // enough to let anyone in.
        await db.query(
            `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [userId, adminRoleId]
        );

        log(`Super admin ready: ${phone}`);
    } catch (err) {
        // Never prevent the API from starting over this.
        log(`Super admin bootstrap failed: ${err.message}`);
    }
}

module.exports = { ensureSuperAdmin };
