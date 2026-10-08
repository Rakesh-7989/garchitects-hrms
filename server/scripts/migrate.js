const path = require('path');
const fs = require('fs');
require('dotenv').config();
const { getPool } = require('../config/database');

/**
 * Safe migration: applies every statement from schema.sql EXCEPT the seed
 * INSERTs. All DDL (CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT
 * EXISTS, CREATE INDEX IF NOT EXISTS) is idempotent and additive, so running
 * this against a live database never drops or overwrites existing data. It is
 * used to bring an existing production database up to date with columns that
 * were added to schema.sql after the last full `npm run db:init`.
 *
 * Statement splitting: a naive `.split(';')` breaks on semicolons inside
 * dollar-quoted DO $$ ... $$ bodies and on full-line `--` comments. This file
 * uses a small tokenizer that tracks `--` line comments, '...' / "..." string
 * literals (with '' escaping) and $tag$ dollar quotes, so every real statement
 * is extracted once. Any statement that still fails is reported and the run
 * exits non-zero — a silently-partial migration hides schema drift.
 */
function splitStatements(sql) {
    const statements = [];
    let cur = '';
    let i = 0;
    const n = sql.length;
    let inLine = false;   // -- comment
    let inSingle = false; // '...'
    let inDouble = false; // "..."
    let inDollar = false; // $tag$...$tag$
    let dollarTag = '';
    while (i < n) {
        const c = sql[i];
        const next = sql[i + 1];
        if (inLine) {
            cur += c;
            if (c === '\n') inLine = false;
            i++;
            continue;
        }
        if (inSingle) {
            cur += c;
            if (c === "'" && next === "'") { cur += next; i += 2; continue; }
            if (c === "'") inSingle = false;
            i++;
            continue;
        }
        if (inDouble) {
            cur += c;
            if (c === '"' && next === '"') { cur += next; i += 2; continue; }
            if (c === '"') inDouble = false;
            i++;
            continue;
        }
        if (inDollar) {
            cur += c;
            if (sql.startsWith(dollarTag, i)) { cur += dollarTag; i += dollarTag.length; inDollar = false; }
            else i++;
            continue;
        }
        // NORMAL state
        if (c === '-' && next === '-') { cur += '--'; i += 2; inLine = true; continue; }
        if (c === "'") { inSingle = true; cur += c; i++; continue; }
        if (c === '"') { inDouble = true; cur += c; i++; continue; }
        if (c === '$') {
            if (next === '$') { inDollar = true; dollarTag = '$$'; cur += '$$'; i += 2; continue; }
            let j = i + 1;
            let tag = '';
            while (j < n && /[A-Za-z0-9_]/.test(sql[j])) { tag += sql[j]; j++; }
            if (sql[j] === '$' && tag.length > 0 && /^[A-Za-z_]/.test(tag[0])) {
                inDollar = true;
                dollarTag = '$' + tag + '$';
                cur += dollarTag;
                i = j + 1;
                continue;
            }
            cur += c;
            i++;
            continue;
        }
        if (c === ';') {
            const t = cur.trim();
            if (t.length > 0) statements.push(t);
            cur = '';
            i++;
            continue;
        }
        cur += c;
        i++;
    }
    const tail = cur.trim();
    if (tail.length > 0) statements.push(tail);
    return statements;
}

async function migrate() {
    const schemaPath = path.join(__dirname, '../schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set. Add your Supabase connection string to .env first.');
        process.exit(1);
    }

    const statements = splitStatements(schema).filter(s => !/^INSERT/i.test(s));

    console.log(`Applying ${statements.length} schema statements (DDL only, no seed data)...`);
    const pool = getPool();
    let applied = 0;
    let failed = 0;
    try {
        for (const stmt of statements) {
            try {
                await pool.query(stmt);
                applied++;
            } catch (e) {
                failed++;
                console.error(`Statement failed (skipping): ${e.message}`);
                console.error(`  SQL: ${stmt.slice(0, 150)}...`);
            }
        }
        console.log(`Done. ${applied}/${statements.length} statements applied successfully${failed ? `, ${failed} FAILED` : '.'}`);
    } catch (e) {
        console.error('Migration error:', e.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
    if (failed > 0) {
        console.error(`Migration incomplete: ${failed} statement(s) failed. Fix the drift and re-run.`);
        process.exit(1);
    }
}

if (require.main === module) {
    migrate();
}

module.exports = { splitStatements };