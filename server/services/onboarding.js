const { query } = require('../config/database');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { sendToUser } = require('./push');

// Default checklists used to self-seed an empty hr_task_templates table.
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

const DEFAULT_OFFBOARDING_TEMPLATES = [
    { title: 'Return company assets (laptop, ID card, access badge)', description: 'Collect the company laptop, ID card and building access from the departing employee.', assignee_role: 'admin', sequence: 1 },
    { title: 'Revoke office email & tool access', description: 'Disable the office email account and revoke access to the tools the employee used.', assignee_role: 'admin', sequence: 2 },
    { title: 'Hand over project files & working documents', description: 'Hand over project drawings, files and working documents to the reporting manager / project lead.', assignee_role: 'employee', sequence: 3 },
    { title: 'Complete knowledge-transfer / handover notes', description: 'Write short handover notes covering open tasks, clients and any follow-ups for the person taking over.', assignee_role: 'employee', sequence: 4 },
    { title: 'Office clearance (desk, keys, parking)', description: 'Clear the desk, return keys and parking access, and confirm nothing is left at the office.', assignee_role: 'employee', sequence: 5 },
    { title: 'Final settlement - leave balance, advances & dues', description: 'Reconcile pending leave balance, advances, expenses and any dues before the last working day.', assignee_role: 'admin', sequence: 6 },
    { title: 'Apply for relieving letter & experience certificate', description: 'Raise the relieving letter / experience certificate request through the Letters module once settled.', assignee_role: 'employee', sequence: 7 }
];

// Insert the defaults for a journey type once if no templates of that type
// exist. Idempotent via ON CONFLICT (title) DO NOTHING, so a concurrent start
// cannot duplicate rows.
async function ensureTemplatesSeeded(type = 'onboarding') {
    const t = type === 'offboarding' ? 'offboarding' : 'onboarding';
    const r = await runWithSchemaRepair(() => query(
        'SELECT COUNT(*)::int AS count FROM hr_task_templates WHERE type = $1', [t]
    ));
    if (r.rows[0].count > 0) return;
    const defaults = t === 'offboarding' ? DEFAULT_OFFBOARDING_TEMPLATES : DEFAULT_TEMPLATES;
    for (const tpl of defaults) {
        await runWithSchemaRepair(() => query(
            `INSERT INTO hr_task_templates (title, description, assignee_role, sequence, type)
            VALUES ($1, $2, $3, $4, $5) ON CONFLICT (title) DO NOTHING`,
            [tpl.title, tpl.description, tpl.assignee_role, tpl.sequence, t]
        ));
    }
}

// Shared journey starter. Never throws - callers decide how to surface
// { ok:false, error }.
async function startProcess(employeeId, actorId, type) {
    try {
        employeeId = Number(employeeId);
        if (!Number.isInteger(employeeId)) {
            return { ok: false, error: 'Invalid employee id' };
        }
        const t = type === 'offboarding' ? 'offboarding' : 'onboarding';

        await ensureTemplatesSeeded(t);

        // One journey per employee + type: UNIQUE(employee_id, type) is the
        // real guard, this pre-check just avoids a needless insert attempt.
        const existing = await runWithSchemaRepair(() => query(
            'SELECT id FROM employee_processes WHERE employee_id = $1 AND type = $2',
            [employeeId, t]
        ));
        if (existing.rows.length > 0) {
            return { ok: true, already: true, processId: existing.rows[0].id };
        }

        const proc = await runWithSchemaRepair(() => query(
            `INSERT INTO employee_processes (employee_id, type, started_by)
            VALUES ($1, $2, $3)
            ON CONFLICT (employee_id, type) DO NOTHING
            RETURNING id`,
            [employeeId, t, actorId || null]
        ));
        if (proc.rows.length === 0) {
            return { ok: true, already: true };
        }
        const processId = proc.rows[0].id;

        const templates = await runWithSchemaRepair(() => query(
            `SELECT id, title, description, assignee_role, sequence
            FROM hr_task_templates WHERE is_active = 1 AND type = $1
            ORDER BY sequence ASC, id ASC`,
            [t]
        ));
        for (const tpl of templates.rows) {
            await runWithSchemaRepair(() => query(
                `INSERT INTO process_tasks
                    (process_id, template_id, title, description, assignee_role, sequence)
                VALUES ($1, $2, $3, $4, $5, $6)`,
                [processId, tpl.id, tpl.title, tpl.description, tpl.assignee_role, tpl.sequence || 0]
            ));
        }

        // Best-effort push - failures must not affect creation.
        try {
            await sendToUser(employeeId, {
                title: t === 'offboarding' ? 'Offboarding checklist started' : 'Welcome to G-Architects HRMS!',
                body: t === 'offboarding'
                    ? 'Your exit checklist is ready. Log in and complete the handover tasks assigned to you.'
                    : 'Your onboarding checklist is ready. Log in and complete your pending tasks.',
                url: '/employee/onboarding'
            });
        } catch (e) {
            console.error('Process start push error:', e.message);
        }

        return { ok: true, processId, tasksCreated: templates.rows.length };
    } catch (e) {
        console.error(`Start ${type || 'onboarding'} error:`, e.message);
        return { ok: false, error: e.message };
    }
}

// Start (or report the already-running) onboarding journey for an employee.
async function startOnboarding(employeeId, actorId) {
    return startProcess(employeeId, actorId, 'onboarding');
}

// Start (or report the already-running) offboarding journey for an employee.
async function startOffboarding(employeeId, actorId) {
    return startProcess(employeeId, actorId, 'offboarding');
}

module.exports = { startOnboarding, startOffboarding, ensureTemplatesSeeded, DEFAULT_TEMPLATES, DEFAULT_OFFBOARDING_TEMPLATES };