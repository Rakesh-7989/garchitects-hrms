/**
 * seed-admin.js — idempotent admin account upsert (production-safe).
 *
 * Reads from env: DATABASE_URL (required), ADMIN_EMPLOYEE_ID, ADMIN_EMAIL,
 * ADMIN_PASSWORD, ADMIN_FIRST_NAME, ADMIN_LAST_NAME.
 *
 * Matches an existing row by employee_id OR email; updates it if found,
 * otherwise inserts. Role is forced to 'admin' and status to 'active' so the
 * seeded credentials are guaranteed to be the working admin login.
 *
 * The password never touches git — pass it in via env (GitHub secret when
 * run from CI, shell env when run locally).
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const ADMIN_EMPLOYEE_ID = process.env.ADMIN_EMPLOYEE_ID || 'GA0001';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_FIRST_NAME = process.env.ADMIN_FIRST_NAME || 'Admin';
const ADMIN_LAST_NAME = process.env.ADMIN_LAST_NAME || 'User';

function fail(msg) {
    console.error('✖ ' + msg);
    process.exit(1);
}

(async () => {
    if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set.');
    if (!ADMIN_EMAIL) fail('ADMIN_EMAIL is not set.');
    if (!ADMIN_PASSWORD) fail('ADMIN_PASSWORD is not set.');
    if (ADMIN_PASSWORD === 'your-password') fail('ADMIN_PASSWORD is still a placeholder.');

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 1,
    });

    try {
        // If schema is missing entirely, the subs statements below would fail with
        // "relation does not exist" — surface that clearly instead of a stack trace.
        const schemaOk = await pool.query(
            "SELECT to_regclass('public.employees') AS t"
        );
        if (!schemaOk.rows[0] || !schemaOk.rows[0].t) {
            fail('employees table does not exist. Run schema.sql + init-db.js first.');
        }

        const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

        // Upsert keyed on employee_id OR email — prefer updating an existing row
        // (keeps the original id and any other columns intact).
        const existing = await pool.query(
            `SELECT id FROM employees
             WHERE LOWER(employee_id) = LOWER($1) OR LOWER(email) = LOWER($2)
             ORDER BY CASE WHEN LOWER(employee_id) = LOWER($1) THEN 0 ELSE 1 END
             LIMIT 1`,
            [ADMIN_EMPLOYEE_ID, ADMIN_EMAIL]
        );

        if (existing.rows.length > 0) {
            const r = await pool.query(
                `UPDATE employees
                 SET employee_id = LOWER($1),
                     email = $2,
                     first_name = $3,
                     last_name = $4,
                     password_hash = $5,
                     role = 'admin',
                     status = 'active',
                     must_change_password = 0
                 WHERE id = $6
                 RETURNING id, employee_id, email, role, status`,
                [ADMIN_EMPLOYEE_ID, ADMIN_EMAIL, ADMIN_FIRST_NAME, ADMIN_LAST_NAME, passwordHash, existing.rows[0].id]
            );
            console.log('✔ Updated existing admin row ->', JSON.stringify(r.rows[0]));
        } else {
            const r = await pool.query(
                `INSERT INTO employees
                    (employee_id, first_name, last_name, email, password_hash,
                     joining_date, salary, role, status, must_change_password)
                 VALUES (LOWER($1), $2, $3, $4, $5, CURRENT_DATE, 0, 'admin', 'active', 0)
                 RETURNING id, employee_id, email, role, status`,
                [ADMIN_EMPLOYEE_ID, ADMIN_FIRST_NAME, ADMIN_LAST_NAME, ADMIN_EMAIL, passwordHash]
            );
            console.log('✔ Inserted admin row ->', JSON.stringify(r.rows[0]));
        }

        console.log('✔ Admin login ready: employee_id=' + ADMIN_EMPLOYEE_ID + ' email=' + ADMIN_EMAIL);
    } catch (e) {
        console.error('✖ Seed failed:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();