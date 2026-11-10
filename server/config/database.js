const { Pool } = require('pg');

let pool = null;

function getPool() {
    if (pool) return pool;

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('[DB] DATABASE_URL is not set. Configure it in .env (local) or Vercel environment variables.');
        return null;
    }

    // Use Supabase pooler for serverless (port 6543) or direct connection
    const isRemote = !/localhost|127\.0\.0\.1|sslmode=disable/.test(connectionString);
    const isVercel = !!process.env.VERCEL;
    
    // For serverless, use a smaller pool with shorter timeouts
    const poolConfig = {
        connectionString,
        ssl: isRemote ? { rejectUnauthorized: false } : undefined,
        max: isVercel ? 1 : parseInt(process.env.PGPOOL_MAX || '5', 10),
        idleTimeoutMillis: isVercel ? 5000 : 30000,
        connectionTimeoutMillis: 10000,
        // Allow exit even if pool has idle connections
        allowExitOnIdle: true
    };

    pool = new Pool(poolConfig);

    pool.on('error', (err) => {
        console.error('Unexpected pg pool error:', err.message);
    });

    return pool;
}

// Errors that mean "this connection is gone", not "your SQL is wrong".
// The Supabase transaction pooler (port 6543) closes idle connections, and a
// query that starts right after a transfer can hit a dead socket - which is
// what killed the startup migration on Vercel ("Connection terminated due to
// connection timeout"). A dead connection must never fail the caller: the
// pool is recycled so the NEXT attempt opens a fresh one.
const CONNECTION_ERROR = /Connection terminated|Connection timeout|timeout expired|connection timeout|ECONNRESET|EPIPE|ETIMEDOUT|Client has encountered a connection error|server closed the connection/i;

function isConnectionError(err) {
    return !!err && CONNECTION_ERROR.test(String(err.message || ''));
}

function recyclePool() {
    const p = pool;
    pool = null;
    if (p) p.end().catch(() => {});
}

// Postgres-flavoured query helper. Routes were written against a SQLite shim that
// emulated RETURNING + $N placeholders. pg supports all of these natively, so this
// is just a thin wrapper that keeps the old result shape ({ rows, changes }).
async function query(sql, params = []) {
    const p = getPool();
    if (!p) {
        throw new Error('Database not configured. Set DATABASE_URL environment variable.');
    }
    try {
        const result = await p.query(sql, params);
        return {
            rows: result.rows || [],
            changes: result.rowCount != null ? result.rowCount : 0,
            lastInsertRowid: result.rows && result.rows.length > 0 ? result.rows[0].id : undefined
        };
    } catch (err) {
        if (isConnectionError(err)) {
            console.warn('[DB] connection lost, recycling the pool:', err.message);
            recyclePool();
        }
        throw err;
    }
}

// For serverless: get a fresh client per request (avoids pool issues)
async function getClient() {
    const p = getPool();
    return p.connect();
}

const poolLike = {
    query: (sql, params) => query(sql, params),
    end: () => { const p = getPool(); return p ? p.end() : Promise.resolve(); }
};

module.exports = { query, pool: poolLike, getPool, getClient, isConnectionError };
