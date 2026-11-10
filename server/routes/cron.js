const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { runAutoMark } = require('../services/attendanceAutoMark');
const { runAutoCheckout } = require('../services/attendanceAutoCheckout');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { CRON_JOBS, STALE_AFTER_HOURS } = require('../config/cronJobs');

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is
// configured on the project (plus an `x-vercel-cron` header).
//
// Three hardening rules, each of which has a documented Vercel failure mode:
//
//   1. "If the secret contains line breaks or leading/trailing whitespace the
//      endpoint returns 401 for EVERY invocation." A secret pasted into the
//      dashboard with a trailing newline therefore silently kills the whole
//      schedule - the job never runs and nothing reports it. => trim BOTH
//      sides before comparing.
//   2. The bearer scheme is case-insensitive (RFC 7235) => accept any
//      casing of "Bearer".
//   3. A plain `===` short-circuits on the first mismatch (timing leak) =>
//      compare the two buffers with crypto.timingSafeEqual, length-checked
//      first (timingSafeEqual throws on a length mismatch).
//
// Still fails closed: with no CRON_SECRET configured every cron is 401.
function normalizeSecret(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isCronAuthorized(req) {
    const secret = normalizeSecret(process.env.CRON_SECRET);
    if (!secret) return false;
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const m = /^bearer[ \t]+(.+)$/i.exec(header.trim());
    if (!m) return false;
    const provided = Buffer.from(normalizeSecret(m[1]), 'utf8');
    const expected = Buffer.from(secret, 'utf8');
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------------
// Liveness heartbeat
// ---------------------------------------------------------------------------
// "The cron never fired" is invisible from the outside: the endpoint still
// 401s for strangers, the QA suite still passes, and the only symptom shows
// up weeks later as stale attendance/photos/announcements. Every run records a
// row so "did this job actually fire, and did it work?" is answerable from
// the database alone (GET /api/cron/health).
//
// The heartbeat is best-effort: it must never turn a working cron into a 500.
async function recordCronRun(job, status, result, durationMs, source) {
    try {
        // (NOW() AT TIME ZONE 'UTC') stores the heartbeat in UTC regardless of
        // the database session timezone, so the value can be compared with a
        // Vercel schedule (UTC) and rendered to the admin without a guess.
        await runWithSchemaRepair(() => query(
            `INSERT INTO cron_runs (job, last_run_at, last_success_at, last_status, last_result, duration_ms, source)
             VALUES ($1, (NOW() AT TIME ZONE 'UTC'), CASE WHEN $2 = 'ok' THEN (NOW() AT TIME ZONE 'UTC') ELSE NULL END, $2, $3, $4, $5)
             ON CONFLICT (job) DO UPDATE SET
                last_run_at = (NOW() AT TIME ZONE 'UTC'),
                last_success_at = CASE WHEN $2 = 'ok' THEN (NOW() AT TIME ZONE 'UTC') ELSE cron_runs.last_success_at END,
                last_status = $2,
                last_result = $3,
                duration_ms = $4,
                source = $5`,
            [job, status, JSON.stringify(result || {}), durationMs || null, source || null]
        ));
    } catch (e) {
        console.error(`[cron] heartbeat write failed for ${job}:`, e.message);
    }
}

// A rejected Vercel cron invocation is the single most useful diagnostic for
// "the schedule is configured but nothing happens" (wrong/rotated secret).
// It is recorded at most once per job per 10 minutes so a stranger hammering
// the endpoint cannot turn the 401 path into a write amplifier - the guard
// lives in the statement itself (the DO UPDATE ... WHERE), so the throttle
// survives a serverless cold start and needs no in-memory state.
async function recordUnauthorizedCronAttempt(job, req) {
    const schedule = cronSchedule(req);
    // Diagnostics for "the scheduler called us and we rejected it": the header
    // is never logged or stored (it IS the secret), only its shape:
    //   present  - was an Authorization header sent at all?
    //   len      - how long is the token we received vs the one we expect?
    //   scheme   - does it start with "Bearer"?
    // A length mismatch means the header was truncated (a newline inside the
    // secret) or the two sides hold different values; a missing header means
    // the deployment has no CRON_SECRET at all.
    const header = req.headers.authorization;
    const expected = normalizeSecret(process.env.CRON_SECRET);
    const received = typeof header === 'string' ? header.trim() : '';
    const token = /^bearer[ \t]+(.*)$/i.exec(received);
    const detail = {
        reason: 'CRON_SECRET mismatch or missing',
        schedule,
        header_present: typeof header === 'string',
        scheme_ok: !!token,
        received_len: token ? token[1].trim().length : (received ? received.length : 0),
        expected_len: expected.length
    };
    try {
        await runWithSchemaRepair(() => query(
            `INSERT INTO cron_runs (job, last_run_at, last_success_at, last_status, last_result, duration_ms, source)
             VALUES ($1, (NOW() AT TIME ZONE 'UTC'), NULL, 'unauthorized', $2, 0, 'vercel-cron')
             ON CONFLICT (job) DO UPDATE SET
                last_run_at = (NOW() AT TIME ZONE 'UTC'),
                last_status = 'unauthorized',
                last_result = $2,
                source = 'vercel-cron'
             WHERE cron_runs.last_status <> 'unauthorized'
                OR cron_runs.last_run_at < ((NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes')`,
            [job, JSON.stringify(detail)]
        ));
        console.warn('[cron] ' + job + ' rejected: ' + JSON.stringify(detail));
    } catch (e) {
        console.error(`[cron] unauthorized heartbeat failed for ${job}:`, e.message);
    }
}

// Where did the call come from? 'vercel-cron' for the scheduler, 'manual' for
// an operator hitting the endpoint on purpose.
//
// Vercel sends `x-vercel-cron-schedule` (the cron expression that triggered
// the invocation) and a `vercel-cron/1.0` user agent on every scheduled run.
// (`x-vercel-cron` is also accepted - some older invocations set it.)
function isVercelCronRequest(req) {
    if (req.headers['x-vercel-cron-schedule'] !== undefined) return true;
    if (req.headers['x-vercel-cron'] !== undefined) return true;
    const ua = String(req.headers['user-agent'] || '');
    return ua.toLowerCase().startsWith('vercel-cron');
}

// The cron expression that triggered this invocation (null for manual calls).
function cronSchedule(req) {
    const h = req.headers['x-vercel-cron-schedule'];
    return typeof h === 'string' ? h.slice(0, 100) : null;
}

function requestSource(req) {
    return isVercelCronRequest(req) ? 'vercel-cron' : 'manual';
}

// Wraps a cron job: auth guard -> run -> heartbeat -> respond.
function cronHandler(job, run) {
    return async (req, res) => {
        if (!isCronAuthorized(req)) {
            // Only Vercel's own dispatcher is worth recording (a stranger
            // hammering the endpoint must not turn 401s into DB writes).
            if (isVercelCronRequest(req)) await recordUnauthorizedCronAttempt(job, req);
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        const startedAt = Date.now();
        try {
            const result = await run();
            const duration = Date.now() - startedAt;
            const detail = { ...result };
            const schedule = cronSchedule(req);
            if (schedule) detail.schedule = schedule;
            await recordCronRun(job, 'ok', detail, duration, requestSource(req));
            res.json({ success: true, job, ...result });
        } catch (error) {
            console.error(`[cron] ${job} error:`, error);
            await recordCronRun(job, 'error', { message: 'job failed' }, Date.now() - startedAt, requestSource(req));
            res.status(500).json({ success: false, message: 'Server error' });
        }
    };
}

router.get('/auto-attendance', cronHandler('auto-attendance', async () => {
    const marked = await runAutoMark();
    return { marked };
}));

router.get('/auto-checkout', cronHandler('auto-checkout', async () => {
    const result = await runAutoCheckout();
    // runAutoCheckout never throws - it reports its own failure. Surface it as
    // a failed job (500 + error heartbeat) instead of a cheerful 200.
    if (!result || result.success === false) {
        const err = new Error('auto-checkout scan failed');
        err.cronResult = result || {};
        throw err;
    }
    return result;
}));

router.get('/purge-photos', cronHandler('purge-photos', async () => {
    const result = await query("DELETE FROM attendance_photos WHERE expires_at < NOW() OR viewed = 1");
    return { deleted: result.changes };
}));

router.get('/expire-announcements', cronHandler('expire-announcements', async () => {
    const result = await runWithSchemaRepair(() =>
        query("UPDATE announcements SET is_active = 0 WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at <= NOW()")
    );
    return { expired: result.changes || 0 };
}));

// Flips active TL handovers whose window has passed to 'ended'. Mirrors the
// lazy expirePastHandovers() semantics (team-handovers.js) exactly, so the
// cron and the read-time path can never disagree; covers the studio case
// where nobody visits the handover pages during the window gap.
router.get('/expire-handovers', cronHandler('expire-handovers', async () => {
    const result = await runWithSchemaRepair(() =>
        query(`UPDATE team_handovers SET status = 'ended', ended_at = NOW()
               WHERE status = 'active' AND end_date < CURRENT_DATE`)
    );
    return { ended: result.changes || 0 };
}));

// Flip unjustified late check-ins (reason never filed / review not approved)
// into absent. Runs after office hours + grace; idempotent - only rows still
// 'late' from a past date are touched.
router.get('/sweep-late', cronHandler('sweep-late', async () => {
    const result = await runWithSchemaRepair(() =>
        query(`UPDATE attendance a
               SET status = 'absent', remarks = COALESCE(a.remarks, '') || ' [late justification missing/rejected]'
               WHERE a.status = 'late'
                 AND a.date < CURRENT_DATE
                 AND NOT EXISTS (
                     SELECT 1 FROM attendance_justifications aj
                     WHERE aj.attendance_id = a.id AND aj.kind = 'late' AND aj.status = 'approved'
                 )`)
    );
    return { absented: result.changes || 0 };
}));

// ---------------------------------------------------------------------------
// Health / liveness
// ---------------------------------------------------------------------------
// Admin-only (JWT), deliberately NOT CRON_SECRET-gated: the founder must be
// able to SEE that a scheduled job is dead without holding the secret.
//
// Every job in the registry is listed - including the ones that never ran -
// so "scheduled but never fired" is distinguishable from "not scheduled".
//
// The timestamps are rendered with to_char (raw UTC strings) on purpose:
// node-postgres parses a TIMESTAMP column into a JS Date at LOCAL midnight,
// which silently shifts the value by the host's offset (the same class of bug
// as the dateOnly fix). The age is computed by Postgres itself
// (NOW() - last_run_at), so it is timezone-correct on any host.
router.get('/health', verifyToken, isAdmin, async (req, res) => {
    try {
        const rows = await runWithSchemaRepair(() => query(
            `SELECT job,
                    to_char(last_run_at, 'YYYY-MM-DD HH24:MI:SS') AS last_run_at,
                    to_char(last_success_at, 'YYYY-MM-DD HH24:MI:SS') AS last_success_at,
                    last_status, last_result, duration_ms, source,
                    EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - last_run_at)) / 3600.0 AS age_hours_raw,
                    GREATEST(0, EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - last_run_at)) / 3600.0) AS age_hours
               FROM cron_runs`
        ));
        const byJob = new Map(rows.rows.map(r => [r.job, r]));
        const jobs = CRON_JOBS.map((def) => {
            const row = byJob.get(def.job);
            const ageHours = row && row.age_hours !== null && row.age_hours !== undefined
                ? Math.round(Number(row.age_hours) * 100) / 100
                : null;
            return {
                job: def.job,
                path: def.path,
                schedule: def.schedule,
                last_run_at: row ? row.last_run_at : null,
                last_success_at: row ? row.last_success_at : null,
                last_status: row ? row.last_status : null,
                duration_ms: row ? row.duration_ms : null,
                source: row ? row.source : null,
                result: row && row.last_result ? parseJsonSafe(row.last_result) : null,
                age_hours: ageHours,
                never_ran: !row,
                stale: !row || (ageHours !== null && ageHours > STALE_AFTER_HOURS),
                failing: !!(row && (row.last_status === 'error' || row.last_status === 'unauthorized'))
            };
        });
        const staleJobs = jobs.filter(j => j.stale).map(j => j.job);
        const failingJobs = jobs.filter(j => j.failing).map(j => j.job);
        res.json({
            success: true,
            healthy: staleJobs.length === 0 && failingJobs.length === 0,
            stale_after_hours: STALE_AFTER_HOURS,
            stale_jobs: staleJobs,
            failing_jobs: failingJobs,
            jobs
        });
    } catch (error) {
        console.error('[cron] health error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

function parseJsonSafe(value) {
    try { return JSON.parse(value); } catch (_) { return null; }
}

module.exports = router;
