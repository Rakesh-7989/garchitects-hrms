const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
// Behind Vercel's proxy, req.ip would otherwise always be 127.0.0.1.
// Trusting the proxy makes Express read the real client IP from
// x-forwarded-for so audit logs record where logins actually came from.
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const { query } = require('./config/database');

// Middleware
// 15MB JSON limit: payroll generate/generate-bulk payloads carry base64 PDFs
// (default 100KB limit rejected them with 413). Vercel caps at ~4.5MB anyway,
// and the bulk flow chunks requests client-side to stay under that.
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// CORS lock-down: only the origins listed in ALLOWED_ORIGINS may call the API
// from a browser. Requests without an Origin header (mobile apps, curl,
// server-to-server) are still allowed since they are not subject to CORS.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
    'https://garchitects.in,https://www.garchitects.in,http://localhost:3000,http://127.0.0.1:3000')
    .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin(origin, callback) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(null, false);
    }
}));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/departments', require('./routes/departments'));
app.use('/api/designations', require('./routes/designations'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/regularization', require('./routes/regularization'));
app.use('/api/leave', require('./routes/leave'));
app.use('/api/wfh', require('./routes/wfh'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/holidays', require('./routes/holidays'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/audit-logs', require('./routes/auditLogs'));
app.use('/api/letters', require('./routes/letters'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/profile-updates', require('./routes/profileUpdates'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.use('/api/manager', require('./routes/manager'));
app.use('/api/push', require('./routes/push'));
app.use('/api/cron', require('./routes/cron'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/project-sets', require('./routes/project-sets'));
app.use('/api/daily-work-counts', require('./routes/daily-work-counts'));
app.use('/api/project-reports', require('./routes/project-reports'));
app.use('/api/project-invoices', require('./routes/project-invoices'));
app.use('/api/project-dpr', require('./routes/project-dpr'));
app.use('/api/project-labour', require('./routes/project-labour'));
app.use('/api/project-materials', require('./routes/project-materials'));

// Static files (mounted after API routes so API paths always take precedence)
app.use(express.static(path.join(__dirname, '../public')));

// Serve pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages/login.html'));
});

app.get(['/admin', '/admin/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages/admin-login.html'));
});

// Clean professional URLs: /admin/employees serves pages/admin/employees.html,
// /employee/leave serves pages/employee/leave.html, and so on. The slug is
// strictly validated ([a-z0-9-]) so path traversal is impossible; unknown
// slugs fall through to the 404 handler. The original /pages/*.html paths keep
// working via express.static, so old bookmarks and push links never break.
function servePortalPage(section) {
    return (req, res, next) => {
        let page = req.params.page;
        // Tolerate legacy "/admin/x.html" style links: strip the extension so
        // any missed relative reference still resolves to the clean page.
        if (page && page.toLowerCase().endsWith('.html')) page = page.slice(0, -5);
        if (!/^[a-z0-9-]+$/.test(page)) return next();
        const file = path.join(__dirname, '..', 'public', 'pages', section, page + '.html');
        if (!fs.existsSync(file)) return next();
        res.sendFile(file);
    };
}
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages/login.html'));
});
app.get('/manager/my-team', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages/manager/my-team.html'));
});
app.get('/employee/:page', servePortalPage('employee'));
app.get('/admin/:page', servePortalPage('admin'));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        success: false, 
        message: 'Something went wrong!',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

// Purge expired / already-viewed check-in photos periodically
async function purgeExpiredPhotos() {
    try {
        const result = await query("DELETE FROM attendance_photos WHERE expires_at < NOW() OR viewed = 1");
        if (result.changes > 0) console.log(`[Photos] Purged ${result.changes} expired/viewed photo(s).`);
    } catch (e) {
        console.error('Photo purge error:', e.message);
    }
}

// Payroll repair must reuse the exact /generate math - never a second copy of
// the formula. computeTotals lives in routes/payroll.js and is the verified
// source of truth (mirrored by ppCompute on the client).
const { computeTotals } = require('./routes/payroll');

// One-time repair: recompute payroll net_salary where it does not match the
// generate-time formula used when payslips were processed. Fixes rows corrupted
// by the old string-concatenation bug (e.g. "30000" + "400" = "30000400").
// Net = A (earnings) + C (bonus) - B (deductions) - LOP deduction.
// Employer contributions (D) are informational - never deducted from net.
async function repairPayrollNetSalaries() {
    try {
        const rows = await query(
            `SELECT id,
                basic_salary, hra, conveyance, special_allowance, other_allowance, medical,
                pf, esi, professional_tax, income_tax, loan_deduction, advance_salary, other_deduction,
                bonus, incentive, extra_work,
                employer_pf, employer_esi, employer_contribution,
                working_days, lop_days,
                net_salary FROM payroll`
        );
        let fixed = 0;
        for (const r of rows.rows) {
            const net = computeTotals(r).net;
            if (Number(r.net_salary) === net) continue;
            await query('UPDATE payroll SET net_salary = $1 WHERE id = $2', [net, r.id]);
            fixed++;
        }
        if (fixed > 0) console.log(`[Payroll] Recomputed net_salary for ${fixed} row(s) to match the /generate formula.`);
    } catch (e) {
        console.error('Payroll repair error:', e.message);
    }
}

// Start server (only when run directly, not when imported by the Vercel function)
if (require.main === module) {
    app.listen(PORT, () => {
        repairPayrollNetSalaries();
        purgeExpiredPhotos();
        console.log(`
    ╔══════════════════════════════════════════╗
    ║       G-Architects HRMS Server Started         ║
    ║──────────────────────────────────────────║
    ║  Port: ${PORT}                              ║
    ║  Mode: ${process.env.NODE_ENV || 'development'}                    ║
    ║  URL:  http://localhost:${PORT}             ║
    ╚══════════════════════════════════════════╝
    `);
    });
}

// Auto-migrations: only run when DATABASE_URL is available.
// On Vercel cold-start these run once; if the DB is unreachable they log
// a warning instead of crashing the entire serverless function.
async function runMigrations() {
    if (!process.env.DATABASE_URL) {
        console.warn('[Migration] DATABASE_URL not set – skipping migrations.');
        return;
    }
    try {
        await query(`INSERT INTO leave_types (name, days_per_year, description, gender_eligibility) VALUES ('Sick or Casual', 12, 'For medical or casual reasons (1 paid day per month, rest LOP)', 'all') ON CONFLICT (name) DO NOTHING`);
        await query(`UPDATE leave_types SET is_active = 1, days_per_year = 12 WHERE name = 'Sick or Casual'`);
        await query(`UPDATE leave_types SET is_active = 0 WHERE name IN ('Sick Leave', 'Casual Leave')`);
        await query(`UPDATE leave_types SET is_active = 0 WHERE name IN ('Maternity Leave', 'Paternity Leave', 'Unpaid Leave', 'Earned Leave')`);
        await query(`UPDATE leave_types SET days_per_year = 0 WHERE name IN ('Maternity Leave', 'Paternity Leave')`);
    } catch (e) { console.warn('[Migration] Leave types migration skipped:', e.message); }

    try {
        await query(`ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await query(`ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS hr_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await query(`ALTER TABLE wfh_requests ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await query(`ALTER TABLE wfh_requests ADD COLUMN IF NOT EXISTS hr_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS hr_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        console.log('[Migration] Multi-approver columns ensured.');
    } catch (e) { console.warn('[Migration] Multi-approver columns skipped:', e.message); }

    try {
        await query(`ALTER TABLE project_sets ADD COLUMN IF NOT EXISTS working_days INT DEFAULT 0`);
        await query(`ALTER TABLE project_sets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
        console.log('[Migration] project_sets.working_days/deleted_at columns ensured.');
    } catch (e) { console.warn('[Migration] working_days column skipped:', e.message); }

    // Announcements auto-expiry column – added after the original schema.
    // Without this, every GET /api/announcements 500s with 42703.
    try {
        await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`);
        console.log('[Migration] announcements.expires_at column ensured.');
    } catch (e) { console.warn('[Migration] announcements.expires_at skipped:', e.message); }

    // Projects module tables. Databases initialized before the projects module
    // exists fail every /api/projects create/set/assign call with 42P01 unless
    // the tables are ensured here (idempotent) or lazily healed per-request.
    try {
        await query(`CREATE TABLE IF NOT EXISTS projects (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL UNIQUE,
            customer VARCHAR(255),
            client VARCHAR(255),
            description TEXT,
            status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'paused', 'terminated', 'on_hold', 'completed', 'cancelled')),
            start_date DATE,
            end_date DATE,
            contract_value DECIMAL(14,2) DEFAULT 0,
            location VARCHAR(255),
            project_type VARCHAR(50) DEFAULT 'other',
            phase VARCHAR(30) DEFAULT 'planning',
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`);
        await query(`CREATE TABLE IF NOT EXISTS project_employees (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE CASCADE,
            employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
            assigned_at TIMESTAMP DEFAULT NOW(),
            status VARCHAR(20) DEFAULT 'active',
            UNIQUE(project_id, employee_id)
        )`);
        await query(`CREATE TABLE IF NOT EXISTS project_sets (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            total_target INT NOT NULL DEFAULT 0,
            working_days INT DEFAULT 0,
            status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
            deleted_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`);
        await query(`CREATE TABLE IF NOT EXISTS daily_work_counts (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE CASCADE,
            set_id INT REFERENCES project_sets(id) ON DELETE CASCADE,
            employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
            work_date DATE NOT NULL,
            daily_count INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(project_id, set_id, employee_id, work_date)
        )`);
        // Pre-existing tables created before the projects module added these
        // columns won't get them from CREATE TABLE IF NOT EXISTS, so add them
        // explicitly (idempotent) to avoid 42703 on the sets/count queries.
        await query(`ALTER TABLE daily_work_counts ADD COLUMN IF NOT EXISTS set_id INT REFERENCES project_sets(id) ON DELETE CASCADE`);
        await query(`ALTER TABLE daily_work_counts ADD COLUMN IF NOT EXISTS daily_count INT NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE project_sets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
        console.log('[Migration] Projects module tables ensured.');
    } catch (e) { console.warn('[Migration] Projects module tables skipped:', e.message); }

    // Phase 1 - project lifecycle columns. Pre-existing projects tables created
    // before this release need explicit ALTERs (CREATE TABLE IF NOT EXISTS only
    // helps new databases). All idempotent and additive.
    try {
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date DATE`);
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date DATE`);
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS contract_value DECIMAL(14,2) DEFAULT 0`);
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS location VARCHAR(255)`);
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type VARCHAR(50) DEFAULT 'other'`);
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS phase VARCHAR(30) DEFAULT 'planning'`);
        console.log('[Migration] projects lifecycle columns ensured.');
    } catch (e) { console.warn('[Migration] projects lifecycle columns skipped:', e.message); }

    // Phase 1 - RA bills table (draft -> submitted -> approved -> paid).
    try {
        await query(`CREATE TABLE IF NOT EXISTS project_invoices (
            id SERIAL PRIMARY KEY,
            project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            invoice_no VARCHAR(30) NOT NULL,
            period_start DATE,
            period_end DATE,
            remarks TEXT,
            gross_value DECIMAL(14,2) NOT NULL DEFAULT 0,
            retention_pct DECIMAL(5,2) NOT NULL DEFAULT 7.5,
            retention_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
            net_value DECIMAL(14,2) NOT NULL DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'submitted', 'approved', 'paid')),
            rejected_note TEXT,
            approved_by INT REFERENCES employees(id) ON DELETE SET NULL,
            approved_at TIMESTAMP,
            payment_received DECIMAL(14,2) NOT NULL DEFAULT 0,
            paid_at TIMESTAMP,
            created_by INT REFERENCES employees(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE (project_id, invoice_no)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_project_invoices_project ON project_invoices(project_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_project_invoices_status ON project_invoices(status)`);
        console.log('[Migration] project_invoices table ensured.');
    } catch (e) { console.warn('[Migration] project_invoices table skipped:', e.message); }

    // Phase 2 - site ops tables: DPR + activities, labour register, materials.
    try {
        await query(`CREATE TABLE IF NOT EXISTS project_daily_reports (
            id SERIAL PRIMARY KEY,
            project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            report_date DATE NOT NULL,
            weather VARCHAR(50),
            work_summary TEXT,
            created_by INT REFERENCES employees(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(project_id, report_date)
        )`);
        await query(`CREATE TABLE IF NOT EXISTS dpr_activities (
            id SERIAL PRIMARY KEY,
            dpr_id INT NOT NULL REFERENCES project_daily_reports(id) ON DELETE CASCADE,
            work_item VARCHAR(255) NOT NULL,
            description TEXT,
            qty_done DECIMAL(12,2),
            unit VARCHAR(20),
            remarks TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_dpr_project_date ON project_daily_reports(project_id, report_date DESC)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_dpr_activities_dpr ON dpr_activities(dpr_id)`);
        console.log('[Migration] project_daily_reports + dpr_activities tables ensured.');
    } catch (e) { console.warn('[Migration] DPR tables skipped:', e.message); }

    try {
        await query(`CREATE TABLE IF NOT EXISTS project_labour_register (
            id SERIAL PRIMARY KEY,
            project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            report_date DATE NOT NULL,
            category VARCHAR(50) NOT NULL,
            count INT NOT NULL DEFAULT 0,
            notes TEXT,
            created_by INT REFERENCES employees(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(project_id, report_date, category)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_labour_register_project_date ON project_labour_register(project_id, report_date DESC)`);
        console.log('[Migration] project_labour_register table ensured.');
    } catch (e) { console.warn('[Migration] labour register table skipped:', e.message); }

    try {
        await query(`CREATE TABLE IF NOT EXISTS project_materials (
            id SERIAL PRIMARY KEY,
            project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            material VARCHAR(255) NOT NULL,
            unit VARCHAR(20) DEFAULT 'nos',
            quantity DECIMAL(12,2) NOT NULL DEFAULT 0,
            qty_used DECIMAL(12,2) NOT NULL DEFAULT 0,
            received_on DATE,
            vendor VARCHAR(255),
            purpose TEXT,
            notes TEXT,
            created_by INT REFERENCES employees(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_project_materials_project ON project_materials(project_id)`);
        console.log('[Migration] project_materials table ensured.');
    } catch (e) { console.warn('[Migration] project_materials table skipped:', e.message); }

    // Rename customer → client: add the new column, copy existing data,
    // then use `client` everywhere. The old `customer` column is kept for
    // backward compatibility but is no longer the primary field.
    try {
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS client VARCHAR(255)`);
        await query(`UPDATE projects SET client = customer WHERE client IS NULL AND customer IS NOT NULL`);
        console.log('[Migration] projects.client column ensured, data copied from customer.');
    } catch (e) { console.warn('[Migration] projects.client column skipped:', e.message); }

    // The admin UI offers on_hold/completed/cancelled project statuses, but the
    // original CHECK constraint only allowed active/inactive/paused/terminated.
    // UPDATE /api/projects/:id thus failed with 23514 (check violation) and the
    // chart-facing statuses were silently rejected. Relax the constraint.
    try {
        await query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check`);
        await query(`ALTER TABLE projects ADD CONSTRAINT projects_status_check
            CHECK (status IN ('active', 'inactive', 'paused', 'terminated', 'on_hold', 'completed', 'cancelled'))`);
        console.log('[Migration] projects.status CHECK constraint relaxed.');
    } catch (e) { console.warn('[Migration] projects status CHECK skipped:', e.message); }

    // Employee hold/abscond release (additive only, never touches existing rows).
    // Old statuses active/inactive/paused/terminated stay valid; on_hold +
    // absconded are added. New tracking columns are nullable/IF NOT EXISTS.
    try {
        await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS status_reason TEXT`);
        await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP DEFAULT NOW()`);
        await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS status_changed_by INT REFERENCES employees(id) ON DELETE SET NULL`);
        await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_working_day DATE`);
        await query(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_status_check`);
        await query(`ALTER TABLE employees ADD CONSTRAINT employees_status_check
            CHECK (status IN ('active', 'inactive', 'paused', 'terminated', 'on_hold', 'absconded'))`);
        await query(`CREATE TABLE IF NOT EXISTS employee_status_history (
            id SERIAL PRIMARY KEY,
            employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            old_status VARCHAR(20), new_status VARCHAR(20) NOT NULL,
            reason TEXT NOT NULL, last_working_day DATE,
            changed_by INT REFERENCES employees(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_status_history_employee ON employee_status_history(employee_id, created_at DESC)`);
        console.log('[Migration] employees hold/abscond statuses ensured.');
    } catch (e) { console.warn('[Migration] employees hold/abscond skipped:', e.message); }
}
runMigrations();

module.exports = app;
