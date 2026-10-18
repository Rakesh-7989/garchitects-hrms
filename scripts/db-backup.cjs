#!/usr/bin/env node
/**
 * scripts/db-backup.cjs — one-off verified backup of the Supabase Postgres DB.
 *
 * Runs `pg_dump` (read-only) against DATABASE_URL and writes a plain-SQL dump
 * to `backups/` (gitignored). Intended for the Phase 1 "protect and baseline"
 * step: take a verified backup + confirm restore before any schema change.
 *
 * Safety notes:
 *   - pg_dump is read-only; it does not modify the database.
 *   - The dump contains REAL sensitive data (payroll, PAN/Aadhaar, bank, photos metadata).
 *     The backups/ dir is gitignored and must never be committed.
 *   - Do NOT restore this dump into a local development database seeded with
 *     real HR data — use synthetic data for development (AGENTS.md §11).
 *   - Run this yourself against the target DB; it is not executed here.
 *
 * Run:  node scripts/db-backup.cjs [outfile]
 *   outfile defaults to backups/hrms-<timestamp>.sql
 */
require('dotenv').config();
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const _dbUrl = process.env.DATABASE_URL;
if (!_dbUrl) { console.error('DATABASE_URL is not set'); process.exit(1); }

const out = process.argv[2] || path.join(
    process.cwd(), 'backups', 'hrms-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sql');
fs.mkdirSync(path.dirname(out), { recursive: true });

// pg_dump reads DATABASE_URL from the environment (pg connection params).
// We pass the URL via PGDATABASE/PGPASSWORD-style env or connection-string form.
// pg_dump accepts a conninfo string as the last argument.
try {
    execFileSync('pg_dump', [_dbUrl, '-f', out, '--verbose', '--no-password'], {
        stdio: 'inherit',
        env: { ...process.env, PGCONNECT_TIMEOUT: '30' }
    });
    const size = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
    console.log(`\nBackup written: ${out} (${size} MB)`);
    console.log('Verify restore next: restore to a throwaway DB and run `npm run db:migrate` + a read smoke.');
} catch (e) {
    console.error('pg_dump failed:', e.message);
    console.error('Tip: ensure pg_dump is on PATH (PostgreSQL client tools) and DATABASE_URL is reachable.');
    process.exit(1);
}
