const { query } = require('../config/database');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { sendToUser } = require('./push');

// Default checklist used to self-seed an empty hr_task_templates table.
// db:init seeds the same rows via schema.sql; this covers databases that were
// only brought up with db:migrate (which skips INSERT statements).
const DEFAULT_TEMPLATES = [
    { title: 'Complete your profile details', description: 'Log in and fill your personal, contact and identification details under My Profile.', assignee_role: 'employee', sequence: 1 },
    { title: 'Submit bank & statutory details', description: 'Add bank account, PAN, Aadhaar and UAN/PF/ESI numbers in My Profile for payroll processing.', assignee_role: 'employee', sequence: 2 },
    { title: 'Collect laptop, ID card & access badge', description: 'Hand over the company laptop, ID card and building access to the new joiner.', assignee_role: 'admin', sequence: 3 },
    { title: 'Create office email & tool access', description: 'Set up the office email account and grant access to the tools the employee needs.', assignee_role: 'admin', sequence: 4 },
    { title: 'Meet reporting manager & team introduction', description: 'Introductory meeting with the reporting manager and the team.', assignee_role: 'employee', sequence: 5 },
    { title: 'Acknowledge company policies', description: 'Read and acknowledge the HR, attendance and leave policies.', assignee_role: 'employee', sequence: 6 }
];

// Insert the defaults once if no templates exist at all. Idempotent via
// ON CONFLICT (title) DO NOTHING, so a concurrent start cannot duplicate rows.
async function ensureTemplatesSeeded() {
    const r = await runWithSchemaRepair(() => query('SELECT COUNT(*)::int AS count FROM hr_task_templates'));
    if (r.rows[0].count > 0) return;
    for (const t of DEFAULT_TEMPLATES) {
        await runWithSchemaRepair(() => query(
            `INSERT INTO hr_task_templates (title, description, assignee_role, sequence)
            VALUES ($1, $2, $3, $4) ON CONFLICT (title) DO NOTHING`,
            [t.title, t.description, t.assignee_role, t.sequence]
        ));
    }
}

// Start (or report the already-running) onboarding journey for an employee:
// creates the employee_processes row, copies every active template into
// per-employee pending tasks and sends a welcome push notification.
// Never throws - callers decide how to surface { ok:false, error }.
async function startOnboarding(employeeId, actorId) {
    try {
        employeeId = Number(employeeId);
        if (!Number.isInteger(employeeId)) {
            return { ok: false, error: 'Invalid employee id' };
        }

        await ensureTemplatesSeeded();

        // One journey per employee: UNIQUE(employee_id, type) is the real
        // guard, this pre-check just avoids a needless insert attempt.
        const existing = await runWithSchemaRepair(() => query(
            "SELECT id FROM employee_processes WHERE employee_id = $1 AND type = 'onboarding'",
            [employeeId]
        ));
        if (existing.rows.length > 0) {
            return { ok: true, already: true, processId: existing.rows[0].id };
        }

        const proc = await runWithSchemaRepair(() => query(
            `INSERT INTO employee_processes (employee_id, type, started_by)
            VALUES ($1, 'onboarding', $2)
            ON CONFLICT (employee_id, type) DO NOTHING
            RETURNING id`,
            [employeeId, actorId || null]
        ));
        if (proc.rows.length === 0) {
            return { ok: true, already: true };
        }
        const processId = proc.rows[0].id;

        const templates = await runWithSchemaRepair(() => query(
            `SELECT id, title, description, assignee_role, sequence
            FROM hr_task_templates WHERE is_active = 1
            ORDER BY sequence ASC, id ASC`
        ));
        for (const t of templates.rows) {
            await runWithSchemaRepair(() => query(
                `INSERT INTO process_tasks
                    (process_id, template_id, title, description, assignee_role, sequence)
                VALUES ($1, $2, $3, $4, $5, $6)`,
                [processId, t.id, t.title, t.description, t.assignee_role, t.sequence || 0]
            ));
        }

        // Welcome push. Best-effort only - failures must not affect creation.
        try {
            await sendToUser(employeeId, {
                title: 'Welcome to G-Architects HRMS!',
                body: 'Your onboarding checklist is ready. Log in and complete your pending tasks.',
                url: '/employee/onboarding'
            });
        } catch (e) {
            console.error('Onboarding push error:', e.message);
        }

        return { ok: true, processId, tasksCreated: templates.rows.length };
    } catch (e) {
        console.error('Start onboarding error:', e.message);
        return { ok: false, error: e.message };
    }
}

module.exports = { startOnboarding, ensureTemplatesSeeded, DEFAULT_TEMPLATES };
