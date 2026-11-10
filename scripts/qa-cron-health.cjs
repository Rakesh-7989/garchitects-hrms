#!/usr/bin/env node
/**
 * scripts/qa-cron-health.cjs — live cron LIVENESS probe (read-only).
 *
 * The one check that answers "are the scheduled jobs actually running?".
 * A 401 from /api/cron/* only proves the GUARD works; this probes the
 * heartbeat instead, so a dead cron cannot hide behind a green QA suite.
 *
 *   node scripts/qa-cron-health.cjs
 *     QA_BASE_URL      default https://garchitects-hrms.vercel.app
 *     QA_LIVE_ADMIN_ID admin employee id (required)
 *     QA_LIVE_ADMIN_PW admin password   (required)
 *
 * Exit: 0 when every job has a fresh heartbeat, 1 when any job is stale /
 * failing / has never run. Read-only: it only logs in and reads.
 */
const BASE = (process.env.QA_BASE_URL || 'https://garchitects-hrms.vercel.app').replace(/\/$/, '');
const ADMIN_ID = process.env.QA_LIVE_ADMIN_ID;
const ADMIN_PW = process.env.QA_LIVE_ADMIN_PW;

async function jget(path, token) {
    const r = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    let body = null;
    try { body = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body };
}

(async () => {
    console.log(`\n=== cron liveness probe (read-only) ===\ntarget=${BASE}\n`);

    // The route must exist and be JWT-gated (401 without a token).
    const anon = await jget('/api/cron/health');
    const gated = anon.status === 401;
    console.log(`  ${gated ? '✔' : '✖'} GET /api/cron/health (no token) -> ${anon.status}${gated ? '' : '  (expected 401)'}`);

    if (!ADMIN_ID || !ADMIN_PW) {
        console.log('\n  ℹ QA_LIVE_ADMIN_ID / QA_LIVE_ADMIN_PW not set - cannot read the heartbeat table.\n');
        process.exit(gated ? 0 : 1);
    }

    const lr = await fetch(BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: ADMIN_ID, password: ADMIN_PW, portal: 'admin' })
    });
    const lj = await lr.json().catch(() => ({}));
    if (!lj.token) {
        console.log(`  ✖ admin login failed (HTTP ${lr.status})`);
        process.exit(1);
    }
    console.log('  ✔ admin login');

    const h = await jget('/api/cron/health', lj.token);
    if (h.status !== 200 || !h.body || h.body.success !== true) {
        console.log(`  ✖ GET /api/cron/health -> HTTP ${h.status}`);
        process.exit(1);
    }
    const b = h.body;
    console.log(`\n  healthy=${b.healthy}  stale_after_hours=${b.stale_after_hours}\n`);
    let bad = 0;
    for (const j of b.jobs || []) {
        const ok = !j.stale && !j.failing;
        if (!ok) bad++;
        console.log(`  ${ok ? '✔' : '✖'} ${String(j.job).padEnd(22)} ${String(j.schedule).padEnd(12)} ` +
            `last_run=${j.last_run_at || 'never'} (${j.age_hours === null || j.age_hours === undefined ? 'n/a' : j.age_hours + 'h ago'}) ` +
            `status=${j.last_status || '-'} never_ran=${j.never_ran} stale=${j.stale} failing=${j.failing}`);
    }
    console.log(`\n  stale: ${JSON.stringify(b.stale_jobs || [])} | failing: ${JSON.stringify(b.failing_jobs || [])}`);
    if (bad) {
        console.log(`\n  ${bad} job(s) are NOT running. If every job says "never ran", Vercel Cron cannot reach the`);
        console.log('  production domain - check the DNS record for the custom domain (see docs/FEATURE_CRON_LIVENESS.md).');
        console.log('  If a job says "rejected", CRON_SECRET does not match what the deployment expects.\n');
        process.exit(1);
    }
    console.log('\n  All scheduled jobs are running.\n');
    process.exit(0);
})();
