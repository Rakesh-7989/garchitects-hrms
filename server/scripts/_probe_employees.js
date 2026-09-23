require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
(async () => {
    try {
        const r = await p.query('SELECT id, employee_id, first_name, last_name, email, role, status, must_change_password FROM employees ORDER BY id');
        console.log('ROWS:', r.rows.length);
        r.rows.forEach(x => console.log(JSON.stringify(x)));
        if (!r.rows.length) console.log('(empty - no employees yet)');
    } catch (e) {
        console.error('DBERR:', e.message);
    } finally {
        await p.end();
    }
})();