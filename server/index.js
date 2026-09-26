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
app.use('/api/project-reports', require('./routes/project-reports'));
app.use('/api/work-assignments', require('./routes/work-assignments'));
app.use('/api/project-updates', require('./routes/project-updates'));
app.use('/api/project-documents', require('./routes/project-documents'));

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
app.get('/manager/:page', servePortalPage('manager'));
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

    // Announcements auto-expiry column – added after the original schema.
    // Without this, every GET /api/announcements 500s with 42703.
    try {
        await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`);
        console.log('[Migration] announcements.expires_at column ensured.');
    } catch (e) { console.warn('[Migration] announcements.expires_at skipped:', e.message); }

    // Projects module tables. Databases initialized before the projects module
    // exists fail every /api/projects create/assign call with 42P01 unless
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
            location VARCHAR(255),
            project_type VARCHAR(50) DEFAULT 'other',
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
        console.log('[Migration] Projects module tables ensured.');
    } catch (e) { console.warn('[Migration] Projects module tables skipped:', e.message); }

    // Phase 1 - project lifecycle columns. Pre-existing projects tables created
    // before this release need explicit ALTERs (CREATE TABLE IF NOT EXISTS only
    // helps new databases). All idempotent and additive.
    try {
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date DATE`);
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date DATE`);
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS location VARCHAR(255)`);
        await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type VARCHAR(50) DEFAULT 'other'`);
        console.log('[Migration] projects lifecycle columns ensured.');
    } catch (e) { console.warn('[Migration] projects lifecycle columns skipped:', e.message); }

    // Phase 4 - project documents repository (drawings, contracts, approvals).
    // Kept in the HRMS model; the other Phase 4 tables (snags, closeout) were
    // construction-specific and are dropped below.
    try {
        await query(`CREATE TABLE IF NOT EXISTS project_documents (
            id SERIAL PRIMARY KEY,
            project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title VARCHAR(255) NOT NULL,
            doc_type VARCHAR(50) DEFAULT 'other',
            description TEXT,
            file_name VARCHAR(255),
            file_url TEXT,
            uploader_id INT REFERENCES employees(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(project_id)`);
        console.log('[Migration] project_documents table ensured.');
    } catch (e) { console.warn('[Migration] project_documents table skipped:', e.message); }

    // HRMS reshape: drop the SiteTrack-Pro construction tables (RA bills, DPR,
    // labour register, materials, snags, closeout) and the financial lifecycle
    // columns (contract_value, phase) bolted onto the projects module. They are
    // replaced by a single plain architecture-studio daily-update table.
    // Destructive by design (user-approved); runs once after the routes that
    // used these tables are gone.
    try {
        await query(`DROP TABLE IF EXISTS project_closeout_items`);
        await query(`DROP TABLE IF EXISTS project_snags`);
        await query(`DROP TABLE IF EXISTS project_materials`);
        await query(`DROP TABLE IF EXISTS project_labour_register`);
        await query(`DROP TABLE IF EXISTS dpr_activities`);
        await query(`DROP TABLE IF EXISTS project_daily_reports`);
        await query(`DROP TABLE IF EXISTS project_invoices`);
        // Sets/working-days removal: daily_work_counts references project_sets,
        // so the dependent table must be dropped first.
        await query(`DROP TABLE IF EXISTS daily_work_counts`);
        await query(`DROP TABLE IF EXISTS project_sets`);
        await query(`ALTER TABLE projects DROP COLUMN IF EXISTS contract_value`);
        await query(`ALTER TABLE projects DROP COLUMN IF EXISTS phase`);
        // Attendance overtime removed (no overtime concept at the studio).
        await query(`ALTER TABLE attendance DROP COLUMN IF EXISTS overtime_hours`);
        await query(`CREATE TABLE IF NOT EXISTS project_daily_updates (
            id SERIAL PRIMARY KEY,
            project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            update_date DATE NOT NULL,
            task_cat VARCHAR(30) NOT NULL CHECK (task_cat IN ('design', 'drafting', 'site_visit', 'coordination', 'approvals', 'documentation', 'meeting', 'other')),
            description TEXT NOT NULL,
            hours NUMERIC(4,1) DEFAULT 0,
            notes TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`);
        // Unit-aware updates: an employee may log several updates per day, each
        // tied to the unit they worked in. Drop the legacy one-per-project-day
        // uniqueness on DBs created before this release.
        await query(`ALTER TABLE project_daily_updates DROP CONSTRAINT IF EXISTS project_daily_updates_project_id_employee_id_update_date_key`);
        await query(`CREATE INDEX IF NOT EXISTS idx_project_daily_updates_project_date ON project_daily_updates(project_id, update_date DESC)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_project_daily_updates_employee_date ON project_daily_updates(employee_id, update_date DESC)`);
        console.log('[Migration] construction tables dropped; project_daily_updates ensured.');
    } catch (e) { console.warn('[Migration] HRMS project reshape skipped:', e.message); }

    // Units (sub-projects): a project contains physical/functional units (tower,
    // plot, floor, phase...). Employees are assigned per unit and every daily
    // update records the unit the work happened in. An employee may belong to
    // several units on the same project, so the old (project_id, employee_id)
    // uniqueness is relaxed into two partial unique indexes.
    try {
        await query(`CREATE TABLE IF NOT EXISTS project_units (
            id SERIAL PRIMARY KEY,
            project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name VARCHAR(150) NOT NULL,
            code VARCHAR(30),
            description TEXT,
            status VARCHAR(20) DEFAULT 'active',
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(project_id, name)
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_project_units_project ON project_units(project_id)`);
        await query(`ALTER TABLE project_employees ADD COLUMN IF NOT EXISTS unit_id INT REFERENCES project_units(id) ON DELETE SET NULL`);
        await query(`ALTER TABLE project_daily_updates ADD COLUMN IF NOT EXISTS unit_id INT REFERENCES project_units(id) ON DELETE SET NULL`);
        await query(`CREATE INDEX IF NOT EXISTS idx_project_employees_unit ON project_employees(project_id, unit_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_pdu_unit ON project_daily_updates(unit_id)`);
        await query(`ALTER TABLE project_employees DROP CONSTRAINT IF EXISTS project_employees_project_id_employee_id_key`);
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_project_employees_no_unit ON project_employees(project_id, employee_id) WHERE unit_id IS NULL`);
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_project_employees_unit ON project_employees(project_id, employee_id, unit_id) WHERE unit_id IS NOT NULL`);
        console.log('[Migration] project_units ensured; project_employees unit-aware.');
    } catch (e) { console.warn('[Migration] project_units migration skipped:', e.message); }

    // Work Assignments: team-lead/manager assigns concrete tasks to active
    // employees, optionally pinned to a project + unit. Additive only.
    try {
        await query(`CREATE TABLE IF NOT EXISTS work_assignments (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE SET NULL,
            unit_id INT REFERENCES project_units(id) ON DELETE SET NULL,
            assigned_by INT NOT NULL REFERENCES employees(id),
            assigned_to INT NOT NULL REFERENCES employees(id),
            title VARCHAR(200) NOT NULL,
            description TEXT,
            priority VARCHAR(10) DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
            due_date DATE,
            status VARCHAR(20) DEFAULT 'assigned'
                CHECK (status IN ('assigned','in_progress','completed','cancelled')),
            completed_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`);
        await query(`CREATE INDEX IF NOT EXISTS idx_wa_assignee ON work_assignments(assigned_to, status)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_wa_assigner ON work_assignments(assigned_by, status)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_wa_project ON work_assignments(project_id)`);
        console.log('[Migration] work_assignments ensured.');
    } catch (e) { console.warn('[Migration] work_assignments migration skipped:', e.message); }

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
