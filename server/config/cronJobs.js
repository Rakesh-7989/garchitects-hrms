// Single source of truth for the scheduled jobs this app exposes.
//
// Vercel reads the schedule from `vercel.json` (JSON, not JS), so this file
// and vercel.json MUST agree. `scripts/qa-cron.cjs` asserts that they do and
// that every path here is actually implemented in `server/routes/cron.js`.
//
// Why this file exists: a cron that is scheduled but not routed (or routed but
// not scheduled) fails SILENTLY - the endpoint simply 404s (or is never
// called), the QA suite still passes, and the business rule it protects
// (auto-absent, photo purge, late sweep, ...) quietly stops applying.
const CRON_JOBS = [
    { job: 'auto-attendance',      path: '/api/cron/auto-attendance',      schedule: '30 2 * * *' },
    { job: 'auto-checkout',        path: '/api/cron/auto-checkout',        schedule: '45 15 * * *' },
    { job: 'purge-photos',         path: '/api/cron/purge-photos',         schedule: '0 3 * * *' },
    { job: 'expire-announcements', path: '/api/cron/expire-announcements', schedule: '0 4 * * *' },
    { job: 'expire-handovers',     path: '/api/cron/expire-handovers',     schedule: '30 4 * * *' },
    { job: 'sweep-late',           path: '/api/cron/sweep-late',           schedule: '0 16 * * *' }
];

// A daily job that has not run for this long is reported as STALE.
//
// Vercel's Hobby cron precision is +/-59 minutes, so two consecutive daily
// runs of a healthy job are 23h..25h apart. 26h leaves one hour of slack
// before a healthy job is flagged, and still reports a dead job within ~26h.
const STALE_AFTER_HOURS = 26;

module.exports = { CRON_JOBS, STALE_AFTER_HOURS };
