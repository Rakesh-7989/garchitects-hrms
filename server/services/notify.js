const { query } = require('../config/database');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { sendToUser } = require('./push');

// In-app notifications.
//
// Every other route in this HRMS sent web push directly (sendToUser). That has
// two problems this module exists to solve:
//   1. sendToUser returns { sent: 0 } SILENTLY when VAPID is not configured, so
//      with no keys set nothing at all is delivered and nothing says so.
//   2. Push needs the tab open and a granted permission, and leaves no record -
//      so a user who was offline cannot discover what they missed.
//
// So every event is written to user_notifications first (durable, role-agnostic,
// survives until read) and push is layered on top as a best-effort extra.
// NOTHING here may throw: a failed notification must not fail the request that
// produced it.

const MAX_BODY = 400;

function tidy(value) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    if (!s) return null;
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY - 1) + '…' : s;
}

/**
 * Create one in-app notification and best-effort push it.
 *
 * @param {object}  o
 * @param {number}  o.employeeId  recipient (required)
 * @param {string}  o.type        event key, e.g. 'work_update'
 * @param {string}  o.title       short headline
 * @param {string} [o.body]       detail line
 * @param {string} [o.url]        in-app destination
 * @param {string} [o.entityType] e.g. 'project_daily_update'
 * @param {number} [o.entityId]   the thing being notified about
 * @param {number} [o.actorId]    who caused it; skipped if === recipient
 * @returns {Promise<{created:boolean, pushed:number, error?:string}>}
 */
async function notify({ employeeId, type, title, body, url, entityType, entityId, actorId }) {
    const to = parseInt(employeeId, 10);
    if (!to || Number.isNaN(to)) return { created: false, pushed: 0 };
    // Never notify someone about their own action.
    if (actorId && parseInt(actorId, 10) === to) return { created: false, pushed: 0 };
    if (!type || !title) return { created: false, pushed: 0 };

    const params = [to, String(type), tidy(title) || String(type), tidy(body), tidy(url), entityType || null, entityId || null, actorId ? parseInt(actorId, 10) : null];

    try {
        // ON CONFLICT DO NOTHING relies on the partial unique index
        // uq_un_emp_entity; when entity_id IS NULL there is no index row and the
        // insert is always a fresh notification, which is the intent for
        // entity-less events (e.g. "you have N unassigned tasks").
        const res = await runWithSchemaRepair(() => query(
            `INSERT INTO user_notifications
                (employee_id, type, title, body, url, entity_type, entity_id, actor_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            params
        ));

        if (!res.rows || res.rows.length === 0) return { created: false, pushed: 0 };
        const id = res.rows[0].id;

        // Push is strictly an accelerator. It is fire-and-forget and its result
        // is only recorded for diagnostics - it must never surface as an error.
        let pushed = 0;
        try {
            const r = await sendToUser(to, { title: tidy(title), body: tidy(body) || '', url: tidy(url) || '' });
            pushed = r && r.sent ? r.sent : 0;
            if (pushed > 0) {
                await query('UPDATE user_notifications SET pushed_at = NOW() WHERE id = $1', [id]).catch(() => {});
            }
        } catch (e) {
            console.warn('Push delivery failed for notification', id, '-', e.message);
        }

        return { created: true, pushed };
    } catch (error) {
        // Swallow: the caller's own work already succeeded and must not 500
        // because the notification sidecar failed.
        console.error('notify() failed:', error && error.message);
        return { created: false, pushed: 0, error: error && error.message };
    }
}

/** Fire-and-forget notify for a set of recipients. */
async function notifyMany(recipients, payload) {
    const ids = [...new Set((recipients || [])
        .map(x => (x && typeof x === 'object' ? x.employee_id ?? x.id : x))
        .map(x => parseInt(x, 10))
        .filter(x => !Number.isNaN(x) && x > 0))];
    if (!ids.length) return;
    // Sequential on purpose: these are tiny inserts and it keeps the log readable
    // and avoids opening a burst of parallel pool queries on Vercel's max:1 pool.
    for (const id of ids) {
        await notify({ ...payload, employeeId: id });
    }
}

/**
 * Who should be told about an employee's work?
 * Their primary reporting manager and their secondary reporting manager. The
 * secondary is auto-set to the company admin for every non-admin, so the owner
 * sees the whole organisation without anyone having to configure a distribution
 * list. Duplicates are collapsed by notifyMany.
 */
async function managerIdsOf(employeeId) {
    const id = parseInt(employeeId, 10);
    if (!id || Number.isNaN(id)) return [];
    // Internal catch on purpose: this is a sidecar. If it threw out to the caller
    // it would turn a successfully-committed daily update into a 500, which is
    // strictly worse than not notifying anyone.
    const r = await query(
        `SELECT reporting_manager_id, secondary_reporting_manager_id
         FROM employees WHERE id = $1`,
        [id]
    ).catch((e) => {
        console.error('managerIdsOf failed for employee', id, '-', e.message);
        return { rows: [] };
    });
    if (!r.rows.length) return [];
    return [r.rows[0].reporting_manager_id, r.rows[0].secondary_reporting_manager_id]
        .map(x => parseInt(x, 10))
        .filter(x => !Number.isNaN(x) && x > 0);
}

/** Everyone with at least one role that manages people, for org-wide events. */
async function peopleManagerIds() {
    const r = await query(`SELECT id FROM employees WHERE role IN ('admin','manager','hr') AND status = 'active'`);
    return (r.rows || []).map(x => x.id);
}

/**
 * Everyone actually involved in a project, i.e. who a lead's status update is
 * aimed at. Three sources, unioned, because any one alone misses people:
 *   - project_employees          formal membership
 *   - project_leads              the other leads on it
 *   - open work assignments      the doers, even if nobody added them to the
 *                                membership table (which is common - access is
 *                                granted ad hoc)
 * Inactive/exited employees are dropped: nobody wants "X completed task" for
 * someone who left the company last month.
 */
async function projectParticipantIds(projectId) {
    const pid = parseInt(projectId, 10);
    if (!pid || Number.isNaN(pid)) return [];
    const r = await query(
        `SELECT DISTINCT e.id FROM employees e WHERE e.status = 'active' AND e.id IN (
             SELECT pe.employee_id FROM project_employees pe WHERE pe.project_id = $1
             UNION SELECT pl.lead_id FROM project_leads pl WHERE pl.project_id = $1
             UNION SELECT g.employee_id FROM project_access_grants g
                   WHERE g.project_id = $1 AND g.revoked_at IS NULL
                     AND (g.expires_at IS NULL OR g.expires_at > NOW())
             UNION SELECT wa.assigned_to FROM work_assignments wa
                   WHERE wa.project_id = $1 AND wa.status IN ('assigned','in_progress')
         )`,
        [pid]
    ).catch(() => ({ rows: [] }));
    return (r.rows || []).map(x => x.id);
}

module.exports = { notify, notifyMany, managerIdsOf, peopleManagerIds, projectParticipantIds };