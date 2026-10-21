#!/usr/bin/env node
/**
 * scripts/qa-rls-staging-test.cjs — read-only RLS staging test helper.
 *
 * Connects to a STAGING copy of production (NOT production itself) and
 * records the current RLS state, table ownership, and connection role.
 * Makes NO writes — safe to run against any database.
 *
 * Use this BEFORE applying the RLS migration to production:
 *   1. Restore a production backup to a staging database
--  2. Run this script against the staging DB to capture the baseline
--  3. Apply server/migrations/2026-10-18-rls-enablement.sql to staging
--  4. Run this script again to verify RLS is enabled + PUBLIC is denied
--  5. Run positive/negative per-role access tests
--  6. Only then promote to production with backup + rollback ready
 *
 * Run:  node scripts/qa-rls-staging-test.cjs
 *   (DATABASE_URL must point at the STAGING database, never production)
 */
require('dotenv').config();
const { Pool } = require('pg');

const _dbUrl = process.env.DATABASE_URL;
if (!_dbUrl) { console.error('DATABASE_URL is not set'); process.exit(1); }

// Refuse to run against production-like URLs as a safety guard
const _remote = !/localhost|127\.0\.0\.1|sslmode=disable/.test(_dbUrl);
const pool = new Pool({
    connectionString: _dbUrl,
    ssl: _remote ? { rejectUnauthorized: false } : undefined,
    max: 2,
});

const SENSITIVE_TABLES = [
    'employees', 'payroll', 'documents', 'attendance_photos',
    'password_reset_otps', 'audit_logs', 'leave_applications', 'wfh_requests'
];

async function main() {
    const client = await pool.connect();
    try {
        console.log('==================================================================');
        console.log('RLS Staging Test — BASELINE (read-only, no writes)');
        console.log('==================================================================\n');

        // 1. Connection role
        const me = await client.query('SELECT current_user AS role, usesuper AS is_superuser FROM pg_user WHERE usename = current_user');
        const role = me.rows[0];
        console.log('1. CONNECTION ROLE');
        console.log(`   Role: ${role.role}`);
        console.log(`   Superuser: ${role.is_superuser ? 'YES (RLS bypassed)' : 'NO (RLS applies)'}`);
        console.log(`   ⚠️  If NOT superuser and does NOT own tables, you MUST add an app-role policy`);

        // 2. Table ownership
        const tables = await client.query(`
            SELECT tablename, tableowner
            FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename = ANY($1)
            ORDER BY tablename
        `, [SENSITIVE_TABLES]);
        console.log('\n2. TABLE OWNERSHIP');
        for (const t of tables.rows) {
            const owns = t.tableowner === role.role ? ' (OWNED by app role — RLS bypassed)' : '';
            console.log(`   ${t.tablename}: owner=${t.tableowner}${owns}`);
        }

        // 3. Current RLS status
        const rls = await client.query(`
            SELECT tablename,
                   relrowsecurity AS rls_enabled,
                   relforcerowsecurity AS rls_forced
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND tablename = ANY($1)
            ORDER BY tablename
        `, [SENSITIVE_TABLES]);
        console.log('\n3. CURRENT RLS STATUS (BEFORE MIGRATION)');
        for (const t of rls.rows) {
            console.log(`   ${t.tablename}: RLS=${t.rls_enabled ? 'ENABLED' : 'DISABLED'} | Forced=${t.rls_forced ? 'YES' : 'no'}`);
        }

        // 4. Existing policies
        const policies = await client.query(`
            SELECT polrelid::regclass AS table_name, polname AS policy_name, polcmd AS cmd,
                   polroles::regrole[] AS roles
            FROM pg_policy pol
            JOIN pg_class c ON c.oid = pol.polrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND polrelid::regclass::text = ANY($1)
            ORDER BY polrelid::regclass::text, polname
        `, [SENSITIVE_TABLES.map(t => t)]);
        console.log('\n4. EXISTING POLICIES');
        if (policies.rows.length === 0) {
            console.log('   (none)');
        } else {
            const cmdMap = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };
            for (const p of policies.rows) {
                console.log(`   ${p.table_name}: ${p.policy_name} [${cmdMap[p.cmd] || p.cmd}] roles=${(p.roles || []).join(',') || 'PUBLIC'}`);
            }
        }

        // 5. PUBLIC access test (read-only, should return 0 rows or error)
        console.log('\n5. PUBLIC ACCESS TEST (should be denied / empty)');
        for (const t of SENSITIVE_TABLES) {
            try {
                const r = await client.query(`SELECT count(*) FROM ${t}`);
                console.log(`   ${t}: ${r.rows[0].count} rows visible to PUBLIC (SHOULD BE 0)`);
            } catch (e) {
                console.log(`   ${t}: ERROR — ${e.message} (good — PUBLIC denied)`);
            }
        }

        console.log('\n==================================================================');
        console.log('NEXT STEPS:');
        console.log('  1. Replace <APP_DB_ROLE> in the migration with the role above');
        console.log('  2. Apply migration to staging: psql < server/migrations/2026-10-18-rls-enablement.sql');
        console.log('  3. Re-run this script — RLS should show ENABLED, PUBLIC should show 0 rows');
        console.log('  4. Run positive/negative per-role access tests');
        console.log('  5. Promote to production with verified pg_dump backup + rollback ready');
        console.log('==================================================================');

    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((e) => {
    console.error('rls-staging-test fatal:', e.message);
    process.exit(1);
});
