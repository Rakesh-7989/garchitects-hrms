require('dotenv').config();
const { Pool } = require('pg');
(async () => {
    const orig = process.env.DATABASE_URL;
    // Try local Postgres on 5432 (service is running there)
    const candidates = [];
    try {
        const u = new URL(orig);
        candidates.push({ label: 'original:' + u.host + ':' + u.port, url: orig });
        u.port = 5432;
        candidates.push({ label: 'port5432:' + u.hostname + ':5432', url: u.toString() });
    } catch (e) {
        candidates.push({ label: 'original', url: orig });
    }
    for (const c of candidates) {
        const p = new Pool({ connectionString: c.url, ssl: /supabase|\.co\b/.test(c.url) ? { rejectUnauthorized: false } : undefined, max: 1, connectionTimeoutMillis: 8000 });
        try {
            const r = await p.query('SELECT current_database() AS db, current_user AS usr');
            console.log('OK  ', c.label, '=> db=' + r.rows[0].db, 'usr=' + r.rows[0].usr);
            await p.end();
        } catch (e) {
            console.log('FAIL', c.label, '=>', e.message);
            await p.end().catch(() => {});
        }
    }
})();