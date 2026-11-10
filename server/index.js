const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
// Behind Vercel's proxy, req.ip would otherwise always be 127.0.0.1.
// Trust exactly ONE hop (Vercel edge → function): the edge appends the true
// client IP at the end of X-Forwarded-For, so req.ip is the real client and
// cannot be spoofed from the client side. ('true' would let a client rotate
// X-Forwarded-For and defeat the per-IP rate limiter.) See QA_FULL_SYSTEM_REPORT_2026-11-06.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const { query, isConnectionError } = require('./config/database');
const { pgErrorResponse } = require('./utils/schemaRepair');

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

// Security headers on every response (HTML documents are served through this
// function; CSP/X-Frame-Options only affect documents, so applying them here
// covers all portals). CSP is intentionally pragmatic: inline scripts/styles
// are pervasive in the no-build static portal, so script/style allow
// 'unsafe-inline'; everything else is locked to self + https images (profile
// photos live on Supabase Storage).
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
].join('; ');
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});

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
app.use('/api/consent', require('./routes/consent'));
app.use('/api/cron', require('./routes/cron'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/project-reports', require('./routes/project-reports'));
app.use('/api/work-assignments', require('./routes/work-assignments'));
app.use('/api/project-leads', require('./routes/project-leads'));
app.use('/api/project-updates', require('./routes/project-updates'));
app.use('/api/project-status-updates', require('./routes/project-status-updates'));
app.use('/api/project-documents', require('./routes/project-documents'));
app.use('/api/team-transfers', require('./routes/team-transfers'));
app.use('/api/team-handovers', require('./routes/team-handovers'));
app.use('/api/project-access', require('./routes/project-access'));
app.use('/api/team-updates', require('./routes/team-updates'));
app.use('/api/daily-work-logs', require('./routes/daily-work-logs'));

// Static files (mounted after API routes so API paths always take precedence)
app.use(express.static(path.join(__dirname, '../public')));

// Serve pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages/login.html'));
});

app.get(['/admin', '/admin/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages/admin-login.html'));
});

// Bare portal roots must never 404 (audit-wiring F3): typing /manager or
// /employee in the address bar lands on the login page, matching /admin.
app.get(['/manager', '/manager/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages/login.html'));
});
app.get(['/employee', '/employee/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages/login.html'));
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

// Error handling middleware. Known Postgres codes map to friendly 400s via
// pgErrorResponse; anything else 500s generically so internals never leak.
// A 4xx coming from upstream middleware (e.g. body-parser rejecting bad JSON)
// is honored instead of flattened to 500 — clients get an honest status, and
// pgErrorResponse still governs DB-ish errors. Never send err.message in
// production.
const CLIENT_ERRORS = { 400: 'Bad request body.', 413: 'Payload too large.' };
app.use((err, req, res, next) => {
    console.error(err.stack);
    if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({
            success: false,
            message: CLIENT_ERRORS[err.status] || 'Request could not be processed.'
        });
    }
    const mapped = pgErrorResponse(err);
    res.status(mapped.status).json({
        success: false,
        message: mapped.message,
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
// Every migration statement is idempotent (CREATE ... IF NOT EXISTS / ALTER
// ... ADD COLUMN IF NOT EXISTS), so a transient failure can simply be retried.
// On Vercel the startup migration runs on a cold instance against the
// Supabase transaction pooler, which closes idle connections - one statement
// dying mid-run used to skip the WHOLE remaining block (the consent
// column widening never landed in production because of it).
async function migrate(sql, params = []) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return await query(sql, params);
        } catch (e) {
            lastErr = e;
            if (!isConnectionError(e)) throw e;
            console.warn('[Migration] transient connection error, retry ' + (attempt + 1) + '/4: ' + e.message);
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
    }
    throw lastErr;
}

async function runMigrations() {
    if (!process.env.DATABASE_URL) {
        console.warn('[Migration] DATABASE_URL not set – skipping migrations.');
        return;
    }
    // One-time destructive-migration ledger (audit-wiring F1). Drops/reshapes
    // must run exactly once per database, NOT on every cold start — re-queuing
    // ~9 DROP statements behind the first user request on Vercel's single-pool
    // instance is latency jitter + a silent-drop maintenance hazard. Applied
    // names are recorded here; additive ALTER/CREATE IF NOT EXISTS blocks
    // everywhere else stay on the every-boot path (idempotent, cheap).
    async function appliedMigrations() {
        await migrate(`CREATE TABLE IF NOT EXISTS schema_migrations (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            applied_at TIMESTAMP DEFAULT NOW()
        )`);
        const r = await migrate(`SELECT name FROM schema_migrations`);
        return new Set(r.rows.map((m) => m.name));
    }
    try {
        await migrate(`INSERT INTO leave_types (name, days_per_year, description, gender_eligibility) VALUES ('Sick or Casual', 12, 'For medical or casual reasons (1 paid day per month, rest LOP)', 'all') ON CONFLICT (name) DO NOTHING`);
        await migrate(`UPDATE leave_types SET is_active = 1, days_per_year = 12 WHERE name = 'Sick or Casual'`);
        await migrate(`UPDATE leave_types SET is_active = 0 WHERE name IN ('Sick Leave', 'Casual Leave')`);
        await migrate(`UPDATE leave_types SET is_active = 0 WHERE name IN ('Maternity Leave', 'Paternity Leave', 'Unpaid Leave', 'Earned Leave')`);
        await migrate(`UPDATE leave_types SET days_per_year = 0 WHERE name IN ('Maternity Leave', 'Paternity Leave')`);
    } catch (e) { console.warn('[Migration] Leave types migration skipped:', e.message); }

    try {
        await migrate(`ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await migrate(`ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS hr_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await migrate(`ALTER TABLE wfh_requests ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await migrate(`ALTER TABLE wfh_requests ADD COLUMN IF NOT EXISTS hr_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await migrate(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        await migrate(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS hr_id INT REFERENCES employees(id) ON DELETE SET NULL`);
        // Schema F4 parity: attendance break_* columns live in layer A (schema.sql)
        // and C (schemaRepair); mirror them here so a live DB that predates the
        // break feature gets them at startup, not only via a lazy self-heal.
        await migrate(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS break_start TIME`);
        await migrate(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS break_end TIME`);
        await migrate(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS break_log TEXT`);
        // Auto-checkout / missed-checkout tracking + check-in photo links were
        // only ever guaranteed by schema.sql (fresh installs) and the lazy
        // schemaRepair map, while GET /api/attendance/my SELECTs all of them on
        // a raw (non-self-healing) query. A live DB created before those
        // releases therefore 500s every employee attendance read with a bare
        // "Server error". Add them here (idempotent) so any boot heals the DB.
        await migrate(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS auto_checkout BOOLEAN DEFAULT FALSE`);
        await migrate(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS auto_checkout_at TIMESTAMP`);
        await migrate(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checkout_miss_reason TEXT`);
        await migrate(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checkout_miss_reason_at TIMESTAMP`);
        await migrate(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS photo_token TEXT`);
        await migrate(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS photo_token_checkout TEXT`);
        await migrate(`CREATE TABLE IF NOT EXISTS attendance_photos (
            id SERIAL PRIMARY KEY,
            attendance_id INT NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
            employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            photo BYTEA NOT NULL,
            token TEXT NOT NULL UNIQUE,
            viewed INTEGER DEFAULT 0,
            viewed_at TIMESTAMP,
            expires_at TIMESTAMP NOT NULL,
            type VARCHAR(20) DEFAULT 'check_in' CHECK (type IN ('check_in', 'check_out')),
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_attendance_photos_token ON attendance_photos(token)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_attendance_photos_expires ON attendance_photos(expires_at)`);
        // Widen the photo type CHECK for camera-verified breaks (idempotent).
        await migrate(`ALTER TABLE attendance_photos DROP CONSTRAINT IF EXISTS attendance_photos_type_check`);
        await migrate(`ALTER TABLE attendance_photos ADD CONSTRAINT attendance_photos_type_check CHECK (type IN ('check_in','check_out','break_out','break_in'))`);
        // Late check-in / early check-out justifications (reviewed by TL/Manager).
        await migrate(`CREATE TABLE IF NOT EXISTS attendance_justifications (
            id SERIAL PRIMARY KEY,
            attendance_id INT NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
            employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            kind VARCHAR(20) NOT NULL CHECK (kind IN ('late','early_checkout')),
            reason TEXT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
            reviewed_by INT REFERENCES employees(id) ON DELETE SET NULL,
            reviewed_at TIMESTAMP,
            review_note TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE (attendance_id, kind)
        )`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_aj_status ON attendance_justifications(status, created_at DESC)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_aj_employee ON attendance_justifications(employee_id)`);
        // Break reports by any staff member (log + alert only; admin reviews).
        await migrate(`CREATE TABLE IF NOT EXISTS break_reports (
            id SERIAL PRIMARY KEY,
            reporter_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            target_employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            note TEXT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed')),
            admin_note TEXT,
            reviewed_by INT REFERENCES employees(id) ON DELETE SET NULL,
            reviewed_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_br_status ON break_reports(status, created_at DESC)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_br_target ON break_reports(target_employee_id)`);
        console.log('[Migration] Multi-approver columns ensured.');
    } catch (e) { console.warn('[Migration] Multi-approver columns skipped:', e.message); }

    // audit-schema F7: approver + employee indexes for the My Team pending
    // lists and per-employee ticket scans. Additive; performance, not
    // correctness (a missing index never fails a request).
    try {
        await migrate(`CREATE INDEX IF NOT EXISTS idx_leave_applications_approver ON leave_applications(manager_id, hr_id)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_wfh_requests_approver ON wfh_requests(manager_id, hr_id)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_support_tickets_employee ON support_tickets(employee_id)`);
        console.log('[Migration] Approver/employee indexes ensured.');
    } catch (e) { console.warn('[Migration] Approver/employee indexes skipped:', e.message); }

    // Announcements auto-expiry column – added after the original schema.
    // Without this, every GET /api/announcements 500s with 42703.
    try {
        await migrate(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`);
        console.log('[Migration] announcements.expires_at column ensured.');
    } catch (e) { console.warn('[Migration] announcements.expires_at skipped:', e.message); }

    // Projects module tables. Databases initialized before the projects module
    // exists fail every /api/projects create/assign call with 42P01 unless
    // the tables are ensured here (idempotent) or lazily healed per-request.
    try {
        await migrate(`CREATE TABLE IF NOT EXISTS projects (
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
        await migrate(`CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`);
        await migrate(`CREATE TABLE IF NOT EXISTS project_employees (
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
        await migrate(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date DATE`);
        await migrate(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date DATE`);
        await migrate(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS location VARCHAR(255)`);
        await migrate(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type VARCHAR(50) DEFAULT 'other'`);
        console.log('[Migration] projects lifecycle columns ensured.');
    } catch (e) { console.warn('[Migration] projects lifecycle columns skipped:', e.message); }

    // Phase 4 - project documents repository (drawings, contracts, approvals).
    // Kept in the HRMS model; the other Phase 4 tables (snags, closeout) were
    // construction-specific and are dropped below.
    try {
        await migrate(`CREATE TABLE IF NOT EXISTS project_documents (
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
        await migrate(`CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(project_id)`);
        console.log('[Migration] project_documents table ensured.');
    } catch (e) { console.warn('[Migration] project_documents table skipped:', e.message); }

    // HRMS reshape: drop the SiteTrack-Pro construction tables (RA bills, DPR,
    // labour register, materials, snags, closeout) and the financial lifecycle
    // columns (contract_value, phase) bolted onto the projects module. They are
    // replaced by a single plain architecture-studio daily-update table.
    // The DROPs are destructive (user-approved) and run exactly ONCE per
    // database (audit-wiring F1), recorded in schema_migrations so no cold
    // start ever re-queues them. The additive project_daily_updates bootstrap
    // below stays idempotent and runs on every boot like the other ensure-blocks.
    try {
        const applied = await appliedMigrations();
        if (!applied.has('hrms_project_reshape')) {
            await migrate(`DROP TABLE IF EXISTS project_closeout_items`);
            await migrate(`DROP TABLE IF EXISTS project_snags`);
            await migrate(`DROP TABLE IF EXISTS project_materials`);
            await migrate(`DROP TABLE IF EXISTS project_labour_register`);
            await migrate(`DROP TABLE IF EXISTS dpr_activities`);
            await migrate(`DROP TABLE IF EXISTS project_daily_reports`);
            await migrate(`DROP TABLE IF EXISTS project_invoices`);
            // Sets/working-days removal: daily_work_counts references project_sets,
            // so the dependent table must be dropped first.
            await migrate(`DROP TABLE IF EXISTS daily_work_counts`);
            await migrate(`DROP TABLE IF EXISTS project_sets`);
            await migrate(`ALTER TABLE projects DROP COLUMN IF EXISTS contract_value`);
            await migrate(`ALTER TABLE projects DROP COLUMN IF EXISTS phase`);
            // Attendance overtime removed (no overtime concept at the studio).
            await migrate(`ALTER TABLE attendance DROP COLUMN IF EXISTS overtime_hours`);
            await migrate(`INSERT INTO schema_migrations (name) VALUES ('hrms_project_reshape') ON CONFLICT (name) DO NOTHING`);
            console.log('[Migration] one-time HRMS project reshape applied (construction tables dropped).');
        }
        await migrate(`CREATE TABLE IF NOT EXISTS project_daily_updates (
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
        await migrate(`ALTER TABLE project_daily_updates DROP CONSTRAINT IF EXISTS project_daily_updates_project_id_employee_id_update_date_key`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_project_daily_updates_project_date ON project_daily_updates(project_id, update_date DESC)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_project_daily_updates_employee_date ON project_daily_updates(employee_id, update_date DESC)`);
        console.log('[Migration] project_daily_updates ensured.');
    } catch (e) { console.warn('[Migration] HRMS project reshape skipped:', e.message); }

    // Units (sub-projects): a project contains physical/functional units (tower,
    // plot, floor, phase...). Employees are assigned per unit and every daily
    // update records the unit the work happened in. An employee may belong to
    // several units on the same project, so the old (project_id, employee_id)
    // uniqueness is relaxed into two partial unique indexes.
    try {
        await migrate(`CREATE TABLE IF NOT EXISTS project_units (
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
        await migrate(`CREATE INDEX IF NOT EXISTS idx_project_units_project ON project_units(project_id)`);
        await migrate(`ALTER TABLE project_employees ADD COLUMN IF NOT EXISTS unit_id INT REFERENCES project_units(id) ON DELETE SET NULL`);
        await migrate(`ALTER TABLE project_daily_updates ADD COLUMN IF NOT EXISTS unit_id INT REFERENCES project_units(id) ON DELETE SET NULL`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_project_employees_unit ON project_employees(project_id, unit_id)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_pdu_unit ON project_daily_updates(unit_id)`);
        await migrate(`ALTER TABLE project_employees DROP CONSTRAINT IF EXISTS project_employees_project_id_employee_id_key`);
        await migrate(`CREATE UNIQUE INDEX IF NOT EXISTS uq_project_employees_no_unit ON project_employees(project_id, employee_id) WHERE unit_id IS NULL`);
        await migrate(`CREATE UNIQUE INDEX IF NOT EXISTS uq_project_employees_unit ON project_employees(project_id, employee_id, unit_id) WHERE unit_id IS NOT NULL`);
        console.log('[Migration] project_units ensured; project_employees unit-aware.');
    } catch (e) { console.warn('[Migration] project_units migration skipped:', e.message); }

    // Work Assignments: team-lead/manager assigns concrete tasks to active
    // employees, optionally pinned to a project + unit. Additive only.
    try {
        await migrate(`CREATE TABLE IF NOT EXISTS work_assignments (
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
                CHECK (status IN ('assigned','in_progress','completed','cancelled','pending')),
            completed_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`);
        // Work-assignments redesign (v2): "blocked" state + reasons + actual
        // timestamps. Additive columns; the status CHECK is re-created so the
        // new state is accepted on databases created before this release.
        await migrate(`ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS blocked_reason TEXT`);
        await migrate(`ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
        await migrate(`ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS started_at TIMESTAMP`);
        await migrate(`ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP`);
        await migrate(`ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS start_date DATE`);
        await migrate(`ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP DEFAULT NOW()`);
        // One-off repair: legacy rows were backfilled with the migration instant
        // when assigned_at was added; restore it to the created_at we do know.
        await migrate(`UPDATE work_assignments SET assigned_at = created_at WHERE assigned_at IS NOT NULL AND created_at IS NOT NULL AND assigned_at > created_at + interval '1 minute'`);
        await migrate(`ALTER TABLE work_assignments DROP CONSTRAINT IF EXISTS work_assignments_status_check`);
        await migrate(`ALTER TABLE work_assignments ADD CONSTRAINT work_assignments_status_check CHECK (status IN ('assigned','in_progress','blocked','completed','cancelled','pending'))`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_wa_assignee ON work_assignments(assigned_to, status)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_wa_assigner ON work_assignments(assigned_by, status)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_wa_project ON work_assignments(project_id)`);
        console.log('[Migration] work_assignments ensured.');
    } catch (e) { console.warn('[Migration] work_assignments migration skipped:', e.message); }

    // Assignment activity trail (Increment 2): appended on create/status/edit/
    // reassign/delete so the UI drawer can render a per-assignment timeline.
    // assignment_id is nullable + ON DELETE SET NULL so deleting an assignment
    // keeps its trail instead of cascading it away.
    try {
        await migrate(`CREATE TABLE IF NOT EXISTS work_assignment_events (
            id SERIAL PRIMARY KEY,
            assignment_id INT REFERENCES work_assignments(id) ON DELETE SET NULL,
            actor_id INT REFERENCES employees(id) ON DELETE SET NULL,
            type VARCHAR(30) NOT NULL,
            from_status VARCHAR(20),
            to_status VARCHAR(20),
            note TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_wae_assignment ON work_assignment_events(assignment_id, created_at DESC)`);
        console.log('[Migration] work_assignment_events ensured.');
    } catch (e) { console.warn('[Migration] work_assignment_events migration skipped:', e.message); }

    // Daily work logs (self-reported) + optional link to an assignment.
    try {
        await migrate(`CREATE TABLE IF NOT EXISTS daily_work_logs (
            id SERIAL PRIMARY KEY,
            employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            work_date DATE NOT NULL,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            project_id INT REFERENCES projects(id) ON DELETE SET NULL,
            unit_id INT REFERENCES project_units(id) ON DELETE SET NULL,
            assignment_id INT REFERENCES work_assignments(id) ON DELETE SET NULL,
            logged_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE (employee_id, work_date, title)
        )`);
        await migrate(`ALTER TABLE daily_work_logs ADD COLUMN IF NOT EXISTS assignment_id INT REFERENCES work_assignments(id) ON DELETE SET NULL`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_daily_work_logs_assignment ON daily_work_logs(assignment_id)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_daily_work_logs_employee_date ON daily_work_logs(employee_id, work_date DESC)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_daily_work_logs_work_date ON daily_work_logs(work_date DESC)`);
        console.log('[Migration] daily_work_logs ensured.');
    } catch (e) { console.warn('[Migration] daily_work_logs migration skipped:', e.message); }

    // Project Leads (P9): designated owners of a project / its units. unit_id
    // NULL = whole project (future units auto-follow); rows are additive only.
    try {
        await migrate(`CREATE TABLE IF NOT EXISTS project_leads (
            id SERIAL PRIMARY KEY,
            project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            lead_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            unit_id INT REFERENCES project_units(id) ON DELETE CASCADE,
            assigned_by INT REFERENCES employees(id) ON DELETE SET NULL,
            assigned_at TIMESTAMP DEFAULT NOW()
        )`);
        await migrate(`CREATE UNIQUE INDEX IF NOT EXISTS uq_project_lead_project ON project_leads(project_id, lead_id) WHERE unit_id IS NULL`);
        await migrate(`CREATE UNIQUE INDEX IF NOT EXISTS uq_project_lead_unit ON project_leads(project_id, unit_id, lead_id) WHERE unit_id IS NOT NULL`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_project_leads_lead ON project_leads(lead_id)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_project_leads_project ON project_leads(project_id)`);
        console.log('[Migration] project_leads ensured.');
    } catch (e) { console.warn('[Migration] project_leads migration skipped:', e.message); }

    // Rename customer → client: add the new column, copy existing data,
    // then use `client` everywhere. The old `customer` column is kept for
    // backward compatibility but is no longer the primary field.
    try {
        await migrate(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS client VARCHAR(255)`);
        await migrate(`UPDATE projects SET client = customer WHERE client IS NULL AND customer IS NOT NULL`);
        console.log('[Migration] projects.client column ensured, data copied from customer.');
    } catch (e) { console.warn('[Migration] projects.client column skipped:', e.message); }

    // The admin UI offers on_hold/completed/cancelled project statuses, but the
    // original CHECK constraint only allowed active/inactive/paused/terminated.
    // UPDATE /api/projects/:id thus failed with 23514 (check violation) and the
    // chart-facing statuses were silently rejected. Relax the constraint.
    try {
        await migrate(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check`);
        await migrate(`ALTER TABLE projects ADD CONSTRAINT projects_status_check
            CHECK (status IN ('active', 'inactive', 'paused', 'terminated', 'on_hold', 'completed', 'cancelled'))`);
        console.log('[Migration] projects.status CHECK constraint relaxed.');
    } catch (e) { console.warn('[Migration] projects status CHECK skipped:', e.message); }

    // Employee hold/abscond release (additive only, never touches existing rows).
    // Old statuses active/inactive/paused/terminated stay valid; on_hold +
    // absconded are added. New tracking columns are nullable/IF NOT EXISTS.
    try {
        await migrate(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS status_reason TEXT`);
        await migrate(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP DEFAULT NOW()`);
        await migrate(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS status_changed_by INT REFERENCES employees(id) ON DELETE SET NULL`);
        await migrate(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_working_day DATE`);
        // audit-schema F5: token_version (force-logout on password reset) was
        // schema-only — add to startup layer B so pre-token_version DBs can
        // use the reset-password flow without a 42703.
        await migrate(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 0`);
        await migrate(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_status_check`);
        await migrate(`ALTER TABLE employees ADD CONSTRAINT employees_status_check
            CHECK (status IN ('active', 'inactive', 'paused', 'terminated', 'on_hold', 'absconded'))`);
        await migrate(`CREATE TABLE IF NOT EXISTS employee_status_history (
            id SERIAL PRIMARY KEY,
            employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            old_status VARCHAR(20), new_status VARCHAR(20) NOT NULL,
            reason TEXT NOT NULL, last_working_day DATE,
            changed_by INT REFERENCES employees(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_status_history_employee ON employee_status_history(employee_id, created_at DESC)`);
        console.log('[Migration] employees hold/abscond statuses ensured.');
    } catch (e) { console.warn('[Migration] employees hold/abscond skipped:', e.message); }

    // Offboarding (shipped 2026-09-30): hr_task_templates gains a type column so
    // onboarding and offboarding checklists stay separate. employee_processes
    // and process_tasks already allowed type='offboarding' in their CHECKs — the
    // journeys were created by the same tables, only the templates were shared.
    // Additive + idempotent; existing onboarding templates keep type='onboarding'.
    try {
        await migrate(`ALTER TABLE hr_task_templates ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'onboarding' CHECK (type IN ('onboarding', 'offboarding'))`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_hr_task_templates_type ON hr_task_templates(type, is_active)`);
        console.log('[Migration] hr_task_templates.type ensured (offboarding ready).');
    } catch (e) { console.warn('[Migration] hr_task_templates.type skipped:', e.message); }

    // Consent records (layer B): created idempotently on every boot so existing
    // databases that predate the consent release can serve /api/consent/*.
    try {
        await migrate(`CREATE TABLE IF NOT EXISTS consent_records (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            notice_key VARCHAR(100) NOT NULL,
            notice_version VARCHAR(50) NOT NULL,
            purpose TEXT NOT NULL,
            choice VARCHAR(20) NOT NULL CHECK (choice IN ('granted', 'declined', 'withdrawn', 'acknowledged')),
            timestamp TIMESTAMP DEFAULT NOW(),
            method VARCHAR(50),
            notice_hash VARCHAR(64),
            locale VARCHAR(10),
            withdrawal_timestamp TIMESTAMP
        )`);
        // The purpose is a full privacy-notice paragraph (300+ chars). It was
        // VARCHAR(100), so every consent record INSERT failed with Postgres
        // 22001 ("value too long") and the consent gate could never be
        // satisfied. Widen it - idempotent, no data loss.
        await migrate(`ALTER TABLE consent_records ALTER COLUMN purpose TYPE TEXT`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_consent_records_user ON consent_records(user_id)`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_consent_records_notice ON consent_records(notice_key, notice_version)`);
        console.log('[Migration] consent_records table ensured.');
    } catch (e) { console.warn('[Migration] consent_records table skipped:', e.message); }

    // Cron liveness heartbeat (layer B). One row per scheduled job, written by
    // every cron run. Without it a job that silently stopped firing (bad
    // secret, dead scheduler, DNS) is indistinguishable from a healthy one -
    // GET /api/cron/health is the only way to see it.
    try {
        await migrate(`CREATE TABLE IF NOT EXISTS cron_runs (
            job VARCHAR(50) PRIMARY KEY,
            last_run_at TIMESTAMP NOT NULL DEFAULT NOW(),
            last_success_at TIMESTAMP,
            last_status VARCHAR(20) NOT NULL DEFAULT 'ok',
            last_result TEXT,
            duration_ms INT,
            source VARCHAR(30),
            updated_at TIMESTAMP DEFAULT NOW()
        )`);
        await migrate(`CREATE INDEX IF NOT EXISTS idx_cron_runs_last_run ON cron_runs(last_run_at DESC)`);
        console.log('[Migration] cron_runs table ensured (cron liveness heartbeat).');
    } catch (e) { console.warn('[Migration] cron_runs table skipped:', e.message); }
}
runMigrations();

module.exports = app;
