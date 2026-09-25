const { query } = require('../config/database');
const { runWithSchemaRepair } = require('./schemaRepair');

// Single source of truth for routing a request (leave / WFH / support ticket)
// to its approvers.
//
// Policy (matches the create/update employee rules in routes/employees.js):
//   EVERY non-admin employee - any designation, any department, any role -
//   is auto-assigned to the main admin as their SECONDARY reporting manager.
//   So:
//     - reporting_manager_id = the employee's direct team lead, falling back
//       to their secondary (the admin). A request therefore ALWAYS has a named
//       reporting manager when one is required - it is never left dangling
//       just because the team lead is missing.
//     - manager_id / hr_id = first active manager and first active HR
//       (parallel fallbacks, unchanged).
async function resolveApproverRouting(empId) {
    const empRes = await runWithSchemaRepair(() => query(
        `SELECT role, reporting_manager_id, secondary_reporting_manager_id
         FROM employees WHERE id = $1`, [empId]
    ));
    const e = empRes.rows[0];
    if (!e) return null;

    const needsManager = e.role === 'employee' || e.role === 'manager' || e.role === 'team_lead' || e.role === 'hr';
    const primaryApprover = e.reporting_manager_id || e.secondary_reporting_manager_id || null;

    const approverRes = await query(
        `SELECT
            (SELECT id FROM employees WHERE role = 'manager' AND status = 'active' LIMIT 1) as manager_id,
            (SELECT id FROM employees WHERE role = 'hr' AND status = 'active' LIMIT 1) as hr_id`
    );
    const a = approverRes.rows[0] || {};

    return {
        role: e.role,
        needsManager,
        primaryApprover,
        reporting_manager_id: needsManager ? primaryApprover : null,
        manager_id: a.manager_id || null,
        hr_id: a.hr_id || null
    };
}

module.exports = { resolveApproverRouting };