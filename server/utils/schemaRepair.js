const { query } = require('../config/database');

// Whether a given table actually has a column. Routes that reference optional
// columns (e.g. project_sets.deleted_at on a legacy DB created before soft
// delete) can gate the reference on this so the query never 500s with 42703.
async function hasColumn(table, column) {
    try {
        const result = await query(
            `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [String(table).replace(/[^a-z0-9_]/gi, ''), String(column).replace(/[^a-z0-9_]/gi, '')]
        );
        return result.rows && result.rows.length > 0;
    } catch (e) {
        console.warn(`[hasColumn] check ${table}.${column} failed:`, e.message);
        return true;
    }
}

// Columns that may have been added to the employees table via ALTER TABLE after
// the production database was first initialized (server/scripts/init-db.js is
// manual-only and was probably last run before the payroll/salary-structure
// columns existed). If any of these are missing, INSERT/UPDATE statements that
// reference them fail with error 42703. The type map below drives an idempotent,
// additive self-heal that never touches existing data.
const EMPLOYEE_ALTER_COLUMNS = {
    basic_salary: 'DECIMAL(10,2) DEFAULT 0',
    hra: 'DECIMAL(10,2) DEFAULT 0',
    conveyance: 'DECIMAL(10,2) DEFAULT 0',
    medical: 'DECIMAL(10,2) DEFAULT 0',
    special_allowance: 'DECIMAL(10,2) DEFAULT 0',
    other_allowance: 'DECIMAL(10,2) DEFAULT 0',
    pf: 'DECIMAL(10,2) DEFAULT 0',
    esi: 'DECIMAL(10,2) DEFAULT 0',
    professional_tax: 'DECIMAL(10,2) DEFAULT 0',
    income_tax: 'DECIMAL(10,2) DEFAULT 0',
    loan_deduction: 'DECIMAL(10,2) DEFAULT 0',
    advance_salary: 'DECIMAL(10,2) DEFAULT 0',
    other_deduction: 'DECIMAL(10,2) DEFAULT 0',
    incentive: 'DECIMAL(10,2) DEFAULT 0',
    bonus: 'DECIMAL(10,2) DEFAULT 0',
    extra_work: 'DECIMAL(10,2) DEFAULT 0',
    employer_pf: 'DECIMAL(10,2) DEFAULT 0',
    employer_esi: 'DECIMAL(10,2) DEFAULT 0',
    employer_contribution: 'DECIMAL(10,2) DEFAULT 0',
    uan_number: 'TEXT',
    pf_number: 'TEXT',
    esi_number: 'TEXT',
    reporting_manager_id: 'INT REFERENCES employees(id) ON DELETE SET NULL',
    // Added by the session-revocation release; verifyToken selects it on every
    // request, so a missing column must be healed before anything else works.
    must_change_password: 'INTEGER DEFAULT 0',
    token_version: 'INTEGER NOT NULL DEFAULT 0',
    // Hold/abscond release: tracking columns, purely additive (nullable).
    status_reason: 'TEXT',
    status_changed_at: 'TIMESTAMP DEFAULT NOW()',
    status_changed_by: 'INT REFERENCES employees(id) ON DELETE SET NULL',
    last_working_day: 'DATE'
};

// Projects module columns that a half-initialized live database may be missing.
// ALTER ... ADD COLUMN IF NOT EXISTS is idempotent; detecting them by the
// column name from the Postgres error message so user input is never interpolated.
const PROJECT_ALTER_COLUMNS = {
    status: "VARCHAR(20) DEFAULT 'active'",
    customer: 'VARCHAR(255)',
    client: 'VARCHAR(255)',
    description: 'TEXT',
    created_at: 'TIMESTAMP DEFAULT NOW()',
    updated_at: 'TIMESTAMP DEFAULT NOW()'
};

// Announcements table columns that may be missing on a live database created
// before the auto-expiry feature was added. The route references a.expires_at
// so the column must exist or every GET /api/announcements 500s.
const ANNOUNCEMENTS_ALTER_COLUMNS = {
    expires_at: 'TIMESTAMP',
    target_audience: "VARCHAR(50) DEFAULT 'all'"
};

// project_sets columns that a half-initialized live database may be missing
// (e.g. the table was created by an older schema without working_days/status).
const PROJECT_SETS_ALTER_COLUMNS = {
    status: "VARCHAR(20) DEFAULT 'active'",
    working_days: 'INT DEFAULT 0',
    total_target: 'INT NOT NULL DEFAULT 0',
    created_at: 'TIMESTAMP DEFAULT NOW()',
    updated_at: 'TIMESTAMP DEFAULT NOW()',
    deleted_at: 'TIMESTAMP'
};

// Tables added in later releases. A live database that predates them fails with
// 42P01 ("relation does not exist"); the DDL below is fully idempotent and only
// ever creates what is missing - existing rows are never touched.
const ENSURE_TABLE_DDL = {
    audit_logs: [
        `CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            actor_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
            action VARCHAR(100) NOT NULL,
            entity_type VARCHAR(50),
            entity_id TEXT,
            details JSONB DEFAULT '{}',
            ip_address VARCHAR(64),
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id)`,
        `CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action)`
    ],
    attendance_regularizations: [
        `CREATE TABLE IF NOT EXISTS attendance_regularizations (
            id SERIAL PRIMARY KEY,
            employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            date DATE NOT NULL,
            check_in TIME,
            check_out TIME,
            reason TEXT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            reviewed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
            review_note TEXT,
            reviewed_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE (employee_id, date)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_att_reg_employee ON attendance_regularizations (employee_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_att_reg_status ON attendance_regularizations (status)`
    ],
    // Onboarding module release. Created lazily on the first 42P01 so no manual
    // db:migrate is required on the live database - purely additive DDL.
    hr_task_templates: [
        `CREATE TABLE IF NOT EXISTS hr_task_templates (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL UNIQUE,
            description TEXT,
            assignee_role VARCHAR(20) NOT NULL DEFAULT 'employee' CHECK (assignee_role IN ('admin', 'employee')),
            sequence INT DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_hr_task_templates_active ON hr_task_templates(is_active)`
    ],
    employee_processes: [
        `CREATE TABLE IF NOT EXISTS employee_processes (
            id SERIAL PRIMARY KEY,
            employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            type VARCHAR(20) NOT NULL DEFAULT 'onboarding' CHECK (type IN ('onboarding', 'offboarding')),
            status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
            started_by INT REFERENCES employees(id) ON DELETE SET NULL,
            started_at TIMESTAMP DEFAULT NOW(),
            completed_at TIMESTAMP,
            UNIQUE (employee_id, type)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_employee_processes_employee ON employee_processes(employee_id)`,
        `CREATE INDEX IF NOT EXISTS idx_employee_processes_status ON employee_processes(status)`
    ],
    process_tasks: [
        `CREATE TABLE IF NOT EXISTS process_tasks (
            id SERIAL PRIMARY KEY,
            process_id INT NOT NULL REFERENCES employee_processes(id) ON DELETE CASCADE,
            template_id INT REFERENCES hr_task_templates(id) ON DELETE SET NULL,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            assignee_role VARCHAR(20) NOT NULL DEFAULT 'employee' CHECK (assignee_role IN ('admin', 'employee')),
            sequence INT DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
            remarks TEXT,
            completed_by INT REFERENCES employees(id) ON DELETE SET NULL,
            completed_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_process_tasks_process ON process_tasks(process_id)`
    ],
    // Projects module release (projects, sets, daily counts). A live database
    // that predates it fails with 42P01 ("relation does not exist") on every
    // project operation - including project creation - unless the DDL below
    // runs first. Fully idempotent and additive; existing rows are untouched.
    projects: [
        `CREATE TABLE IF NOT EXISTS projects (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            customer VARCHAR(255),
            client VARCHAR(255),
            description TEXT,
            status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'paused', 'terminated', 'on_hold', 'completed', 'cancelled')),
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`
    ],
    project_employees: [
        `CREATE TABLE IF NOT EXISTS project_employees (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE CASCADE,
            employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
            assigned_at TIMESTAMP DEFAULT NOW(),
            status VARCHAR(20) DEFAULT 'active',
            UNIQUE(project_id, employee_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_project_employees_project ON project_employees(project_id)`,
        `CREATE INDEX IF NOT EXISTS idx_project_employees_employee ON project_employees(employee_id)`
    ],
    project_sets: [
        `CREATE TABLE IF NOT EXISTS project_sets (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            total_target INT NOT NULL DEFAULT 0,
            working_days INT DEFAULT 0,
            status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            deleted_at TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_project_sets_project ON project_sets(project_id)`,
        `CREATE INDEX IF NOT EXISTS idx_project_sets_status ON project_sets(status)`
    ],
    daily_work_counts: [
        `CREATE TABLE IF NOT EXISTS daily_work_counts (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE CASCADE,
            set_id INT REFERENCES project_sets(id) ON DELETE CASCADE,
            employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
            work_date DATE NOT NULL,
            daily_count INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(project_id, set_id, employee_id, work_date)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_daily_work_counts_project ON daily_work_counts(project_id)`,
        `CREATE INDEX IF NOT EXISTS idx_daily_work_counts_set ON daily_work_counts(set_id)`,
        `CREATE INDEX IF NOT EXISTS idx_daily_work_counts_employee ON daily_work_counts(employee_id)`,
        `CREATE INDEX IF NOT EXISTS idx_daily_work_counts_date ON daily_work_counts(work_date)`,
        `CREATE INDEX IF NOT EXISTS idx_daily_work_counts_unique ON daily_work_counts(project_id, set_id, employee_id, work_date)`
    ],
    employee_status_history: [
        `CREATE TABLE IF NOT EXISTS employee_status_history (
            id SERIAL PRIMARY KEY,
            employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            old_status VARCHAR(20), new_status VARCHAR(20) NOT NULL,
            reason TEXT NOT NULL, last_working_day DATE,
            changed_by INT REFERENCES employees(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_status_history_employee ON employee_status_history(employee_id, created_at DESC)`
    ]
};

function missingColumnInfo(error) {
    // Postgres reports 42703 either as `column "x" of relation "y" does not
    // exist`, `column x.y does not exist`, or `column "x" does not exist`.
    const msg = error && error.message ? String(error.message) : '';
    // Try quoted format first: column "x" [of relation "y"]
    let m = /column "([a-z0-9_]+)"(?:\s+of\s+relation\s+"([a-z0-9_]+)")?\s+does not exist/i.exec(msg);
    // Try unquoted format: column x.y does not exist
    if (!m) m = /column\s+([a-z0-9_]+)\.([a-z0-9_]+)\s+does not exist/i.exec(msg);
    // Try simple unquoted: column x does not exist
    if (!m) m = /column\s+([a-z0-9_]+)\s+does not exist/i.exec(msg);
    const column = (m && m[1]) || (error && error.column) || null;
    const table = (m && m[2]) || (error && error.table) || null;
    return { column, table };
}

function missingTableInfo(error) {
    if (!error || error.code !== '42P01') return null;
    const msg = String((error && error.message) || '');
    const m = /relation "([a-z0-9_]+)" does not exist/i.exec(msg);
    return (m && m[1]) || (error && error.table) || null;
}

async function ensureEmployeeColumn(column) {
    const ddl = EMPLOYEE_ALTER_COLUMNS[column];
    if (!ddl) return false;
    // The column name comes from the database error message, never from user input.
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS "${column}" ${ddl}`);
    return true;
}

async function ensureProjectColumn(column) {
    const ddl = PROJECT_ALTER_COLUMNS[column];
    if (!ddl) return false;
    await query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS "${column}" ${ddl}`);
    return true;
}

async function ensureProjectSetColumn(column) {
    const ddl = PROJECT_SETS_ALTER_COLUMNS[column];
    if (!ddl) return false;
    await query(`ALTER TABLE project_sets ADD COLUMN IF NOT EXISTS "${column}" ${ddl}`);
    return true;
}

async function ensureAnnouncementsColumn(column) {
    const ddl = ANNOUNCEMENTS_ALTER_COLUMNS[column];
    if (!ddl) return false;
    await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS "${column}" ${ddl}`);
    return true;
}

// Columns the project-sets listing / employee views depend on beyond the three
// main tables. If a live DB predates the projects module these can be missing.
const PROJECT_MODULE_ALTER_COLUMNS = {
    'daily_work_counts': {
        set_id: 'INT REFERENCES project_sets(id) ON DELETE CASCADE',
        project_id: 'INT REFERENCES projects(id) ON DELETE CASCADE',
        employee_id: 'INT REFERENCES employees(id) ON DELETE CASCADE',
        work_date: 'DATE',
        daily_count: 'INT NOT NULL DEFAULT 0',
    },
    'project_employees': {
        status: 'VARCHAR(20) DEFAULT \'active\'',
    }
};

async function ensureProjectModuleColumn(table, column) {
    const ddl = (PROJECT_MODULE_ALTER_COLUMNS[table] || {})[column];
    if (!ddl) return false;
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${column}" ${ddl}`);
    return true;
}

async function ensureTable(table) {
    const statements = ENSURE_TABLE_DDL[table];
    if (!statements) return false;
    for (const sql of statements) {
        await query(sql);
    }
    return true;
}

// Runs fn, and if it fails with a missing-column (42703) or missing-table
// (42P01) error, heals the schema and retries. Loops in case several things
// are missing (Postgres reports one at a time).
async function runWithSchemaRepair(fn) {
    const maxAttempts = Object.keys(EMPLOYEE_ALTER_COLUMNS).length
        + Object.keys(PROJECT_ALTER_COLUMNS).length
        + Object.keys(PROJECT_SETS_ALTER_COLUMNS).length
        + Object.keys(ANNOUNCEMENTS_ALTER_COLUMNS).length
        + Object.keys(ENSURE_TABLE_DDL).length + 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt < maxAttempts - 1) {
                if (error && error.code === '42703') {
                    const miss = missingColumnInfo(error);
                    const table = (miss.table || '').toLowerCase() || 'employees';
                    let healed = false;
                    // Try the specific table first
                    if (table === 'projects' || table === 'p') {
                        healed = miss.column && await ensureProjectColumn(miss.column);
                    } else if (table === 'project_sets' || table === 'ps') {
                        healed = miss.column && await ensureProjectSetColumn(miss.column);
                    } else if (table === 'daily_work_counts' || table === 'dwc' || table === 'project_employees' || table === 'pe') {
                        healed = miss.column && await ensureProjectModuleColumn(table === 'dwc' ? 'daily_work_counts' : table === 'pe' ? 'project_employees' : table, miss.column);
                    } else if (table === 'employees' || table === 'e') {
                        healed = miss.column && await ensureEmployeeColumn(miss.column);
                    } else if (table === 'announcements' || table === 'a') {
                        healed = miss.column && await ensureAnnouncementsColumn(miss.column);
                    }
                    // If specific table didn't heal, try all known tables
                    if (!healed && miss.column) {
                        healed = await ensureProjectColumn(miss.column)
                            || await ensureProjectSetColumn(miss.column)
                            || await ensureProjectModuleColumn('daily_work_counts', miss.column)
                            || await ensureProjectModuleColumn('project_employees', miss.column)
                            || await ensureEmployeeColumn(miss.column)
                            || await ensureAnnouncementsColumn(miss.column);
                    }
                    if (healed) {
                        continue;
                    }
                } else {
                    const table = missingTableInfo(error);
                    if (table && await ensureTable(table)) {
                        continue;
                    }
                }
            }
            throw error;
        }
    }
}

// Friendly message for common Postgres errors.
function pgErrorResponse(error) {
    if (error && error.code === '23505') {
        const constraint = error.constraint || '';
        if (constraint.includes('employee_id')) {
            return { status: 400, message: 'This Employee ID is already in use. Please choose a different one.' };
        }
        if (constraint.includes('email')) {
            return { status: 400, message: 'This email address is already in use by another employee.' };
        }
        return { status: 400, message: 'A record with this value already exists.' };
    }
    if (error && error.code === '23503') {
        return { status: 400, message: 'Invalid reference. Please select a valid department, designation or reporting person.' };
    }
    if (error && error.code === '22P02') {
        return { status: 400, message: 'Invalid number or value format. Please enter numbers only.' };
    }
    if (error && (error.code === '22007' || error.code === '22008')) {
        return { status: 400, message: 'Invalid date format.' };
    }
    if (error && error.code === '23514') {
        return { status: 400, message: 'One of the entered values is not allowed for this field.' };
    }
    if (error && error.code === '23502') {
        return { status: 400, message: 'A required field is missing.' };
    }
    return { status: 500, message: 'Server error' };
}

module.exports = { runWithSchemaRepair, ensureEmployeeColumn, ensureProjectColumn, ensureProjectSetColumn, ensureProjectModuleColumn, ensureAnnouncementsColumn, ensureTable, hasColumn, pgErrorResponse, missingColumnInfo };
