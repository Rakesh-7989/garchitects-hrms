#!/usr/bin/env node
/**
 * scripts/rls-map.cjs — read-only Supabase/Postgres RLS inventory.
 *
 * Connects to DATABASE_URL and records, for every public-schema table:
 *   - table name, row count (approx), size
 *   - RLS enabled or disabled (pg_class.relrowsecurity)
 *   - forced RLS (pg_class.relforcerowsecurity) — table owner still bypasses unless forced
 *   - existing policies (pg_policies): name, roles, cmd, qual, with_check
 *   - grants to PUBLIC / roles (information_schema.role_table_grants)
 *
 * Makes NO writes — safe to run against production. Output is a markdown
 * matrix suitable for the security advisor remediation tracker (Phase 1).
 *
 * Run:  node scripts/rls-map.cjs
 *   (DATABASE_URL must be set; do NOT copy the output's data rows into chat)
 */
require('dotenv').config();
const { Pool } = require('pg');

const _dbUrl = process.env.DATABASE_URL;
if (!_dbUrl) { console.error('DATABASE_URL is not set'); process.exit(1); }
const _remote = !/localhost|127\.0\.0\.1|sslmode=disable/.test(_dbUrl);
const pool = new Pool({
    connectionString: _dbUrl,
    ssl: _remote ? { rejectUnauthorized: false } : undefined,
    max: 3,
});

function escSql(ident) {
    return '"' + String(ident).replace(/"/g, '""') + '"';
}

async function main() {
    const client = await pool.connect();
    try {
        // All user tables in public (exclude pg_* / information_schema / Timescale etc.)
        const tables = await client.query(`
            SELECT c.relname AS table_name,
                   c.relrowsecurity AS rls_enabled,
                   c.relforcerowsecurity AS rls_forced,
                   pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
                   (SELECT count(*) FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=c.relname) AS col_count
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND c.relpersistence = 'p'
            ORDER BY c.relname
        `);

        let out = [];
        out.push('# Supabase RLS map — public schema');
        out.push('');
        out.push('Generated: read-only inventory; **no writes made.**');
        out.push('');
        out.push('| Table | RLS | Forced | Cols | Size | Policies | Grants |');
        out.push('|---|---|---|---|---|---|---|');

        const rows = [];
        for (const t of tables.rows) {
            const tbl = t.table_name;
            const rls = t.rls_enabled ? 'ENABLED' : 'DISABLED';
            const forced = t.rls_forced ? 'yes' : 'no';

            // Existing policies
            const pols = await client.query(
                `SELECT polname, polcmd, polroles::regrole[] AS roles,
                        pg_get_expr(polqual, polrelid) AS qual,
                        pg_get_expr(polwithcheck, polrelid) AS with_check
                 FROM pg_policy pol
                 JOIN pg_class c ON c.oid = pol.polrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname='public' AND c.relname = $1
                 ORDER BY polname`,
                [tbl]);
            const policySummary = pols.rows.map(p => {
                const cmd = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' }[p.polcmd] || p.polcmd;
                return `${p.polname} [${cmd}] roles:${(p.roles || []).join(',') || 'PUBLIC'}`;
            }).join('; ') || '—';

            // Grants (non-owner)
            const grants = await client.query(
                `SELECT grantee, privilege_type
                 FROM information_schema.role_table_grants
                 WHERE table_schema='public' AND table_name = $1
                 ORDER BY grantee, privilege_type`,
                [tbl]);
            const grantSummary = grants.rows.reduce((acc, g) => {
                acc[g.grantee] = (acc[g.grantee] || []).concat(g.privilege_type);
                return acc;
            }, {});
            const grantStr = Object.entries(grantSummary)
                .map(([g, ps]) => `${g}:${ps.join(',')}`)
                .join('; ') || '—';

            rows.push({ tbl, rls, forced, cols: t.col_count, size: t.size, policySummary, grantStr });
        }

        for (const r of rows) {
            out.push(`| ${r.tbl} | ${r.rls} | ${r.forced} | ${r.cols} | ${r.size} | ${r.policySummary} | ${r.grantStr} |`);
        }

        const disabled = rows.filter(r => r.rls === 'DISABLED');
        out.push('');
        out.push('## Summary');
        out.push('- Total tables: ' + rows.length);
        out.push('- RLS ENABLED: ' + rows.filter(r => r.rls === 'ENABLED').length);
        out.push('- RLS DISABLED: ' + disabled.length);
        if (disabled.length) {
            out.push('- Disabled tables: ' + disabled.map(r => r.tbl).join(', '));
        }
        const unforced = rows.filter(r => r.rls === 'ENABLED' && r.forced === 'no');
        if (unforced.length) {
            out.push('- RLS enabled but NOT forced (table owner still bypasses): ' + unforced.map(r => r.tbl).join(', '));
        }

        console.log(out.join('\n'));
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((e) => {
    console.error('rls-map fatal:', e.message);
    process.exit(1);
});
