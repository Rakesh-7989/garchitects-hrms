const path = require('path');
const fs = require('fs');
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getPool } = require('../config/database');

// Unambiguous alphabet (no 0/O/1/I/l) so the printed password is easy to type.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generateRandomPassword(length = 12) {
    const bytes = require('crypto').randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
    // Guarantee at least one digit and one uppercase for password policy compliance.
    if (!/[0-9]/.test(out)) out = out.slice(0, -1) + '7';
    if (!/[A-Z]/.test(out)) out = 'G' + out.slice(1);
    return out;
}

async function ensureFirstAdmin(pool) {
    const existing = await pool.query(
        "SELECT id FROM employees WHERE role = 'admin' AND status = 'active' LIMIT 1"
    );
    if (existing.rows.length > 0) {
        console.log('Admin account already exists - skipping first-admin creation.');
        return;
    }

    const password = generateRandomPassword();
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    await pool.query(
        `INSERT INTO employees
            (employee_id, first_name, last_name, email, phone, password_hash,
             joining_date, salary, role, status, department_id, designation_id, gender, must_change_password)
         VALUES ('EMP001', 'Admin', 'User', $1, NULL, $2,
                 CURRENT_DATE, 0, 'admin', 'active', NULL, NULL, NULL, 1)
         ON CONFLICT (email) DO NOTHING`,
        [process.env.ADMIN_EMAIL || 'admin@garchitects.com', password_hash]
    );

    console.log('');
    console.log('========================================');
    console.log(' FIRST ADMIN ACCOUNT CREATED');
    console.log('   Employee ID: EMP001');
    console.log(`   Email: ${process.env.ADMIN_EMAIL || 'admin@garchitects.com'}`);
    console.log(`   Password: ${password}`);
    console.log(' Store this password securely now - it will NOT be shown again.');
    console.log(' The admin will be asked to change it on first login.');
    console.log('========================================');
    console.log('');
}

async function initDatabase() {
    const schemaPath = path.join(__dirname, '../schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set. Add your Supabase connection string to .env first.');
        process.exit(1);
    }

    console.log('Applying schema to Postgres/Supabase...');
    const pool = getPool();
    try {
        await pool.query(schema);
        console.log('Schema applied successfully!');
        await ensureFirstAdmin(pool);
    } catch (error) {
        console.error('Error applying schema:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

initDatabase();
