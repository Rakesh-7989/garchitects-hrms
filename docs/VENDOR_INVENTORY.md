# Vendor / Embed & Data-Sharing Inventory — G-Architects HRMS

**Status:** Draft (Phase 2 preparation)  
**Source:** Static scan of `public/` (HTML/JS/CSS) + `server/` route/service files  
**Method:** Searched for external scripts, iframe/embed, fonts, analytics, maps, video, CAPTCHA, chat, CDN assets, external image hosts, outbound API calls. Cross-checked against blueprint §6 "likely providers to verify".

> This is a verification checklist, not a claim that every vendor receives employee data. Confirmed = observed in source; Potential = declared in config/env but not yet observed in a data flow.

---

## First-party / self-hosted (no data leaves the app)

| Asset | Location | Data shared? | Notes |
|---|---|---|---|
| App CSS / JS | `public/css/main.css`, `public/js/*.js`, `public/pages/**` | No | Self-hosted, served by the Express app / Vercel |
| G-Architects logo | `public/assets/images/garchitects_logo.png` | No | Self-hosted image |
| favicon / apple-touch-icon / manifest | `public/assets/images/*`, `public/manifest.json` | No | Self-hosted |
| Service worker | `public/sw.js` | No | Network-first for navigations; never caches `/api/` |

---

## Third-party providers observed in source (confirmed)

| Provider | Purpose | Data potentially shared | Region | Risk / notes |
|---|---|---|---|---|
| **Font Awesome (cdnjs)** | Icons CSS | Browser metadata (IP, UA) on page load | Global CDN | `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css` loaded on login + all admin pages. Low-sensitivity (no HR data in the request), but a third-party embed. Consider self-hosting if zero third-party assets is desired. |
| **Supabase (Postgres + Storage)** | Database + attendance photo/document storage | Full HR data (DB); photo bytes (Storage) | ap-south-1 (project `wnuozsytcbjpzdvvnlfc`) | App connects via `pg` as service role (not PostgREST/anon key). `@supabase/supabase-js` used **only** in `server/services/storage.js` with `SUPABASE_SERVICE_KEY` (server-side). Confirm storage buckets are private + downloads authorized (blueprint §6/§7 step 6). |
| **Vercel** | Hosting, serverless functions, logs | Function logs, deployment metadata | Vercel infra | Runtime errors observed in Vercel dashboard; logs must not contain secrets/OTP/PAN/Aadhaar/salary/photo tokens (audit-security F1–F4). |
| **SMTP email (Nodemailer)** | Password-reset OTP, notifications | Email body + recipient address | Provider-dependent (env `SMTP_HOST`; example = smtp.gmail.com) | OTP is sent; email body must not contain PAN/Aadhaar/bank/salary (data minimization, §6). SMTP creds are server-side env only. |
| **Web Push (web-push / VAPID)** | PWA notifications | Push endpoint + subscription (browser) | VAPID keys | Only if VAPID configured; push is best-effort, never the sole signal (AGENTS §7). |

---

## Third-party links (external navigation, not embedded tracking)

| Provider | Purpose | Data shared on click | Notes |
|---|---|---|---|
| **Google Maps** | View check-in/check-out location | Lat/long query string (if user clicks "View on Map") | `admin/attendance.html:561,659,667` builds `https://www.google.com/maps?q=lat,lon`, `target="_blank" rel="noopener"`. Not a background request; user-initiated. Location permission is only requested at check-in invocation (blueprint §4 attendance notice). |

---

## Providers declared in config / env (potential — verify data flow)

| Provider | Declared via | Observed in data flow? | Action |
|---|---|---|---|
| SMTP host/user/pass | `.env.example` (`SMTP_*`) | Yes — `server/services/email.js`, `auth.js` forgot-password | Confirm creds are server-side env only; rotate if ever committed |
| VAPID public/private key | `.env.example` (`VAPID_*`) | Yes — `public/js/auth.js:645,663` push subscribe | Only active if keys set; otherwise push silently no-ops |
| Supabase URL / service key | `.env.example` (`SUPABASE_*`) | Yes — `server/services/storage.js` | Confirm bucket privacy; service key never in frontend |
| CRON_SECRET | `.env.example` | Yes — `server/routes/cron.js` fail-closed | Confirm set on Vercel; rotate if exposed |

---

## No third-party trackers found

A scan of `public/` found **none** of the following: Google Analytics, Google Tag Manager, Meta/Facebook pixel, advertising pixels, third-party video embeds (YouTube/Vimeo), chat widgets, CAPTCHA, or external image hosts beyond the self-hosted logo.

Per blueprint §6: do not add analytics/advertising/third-party fonts/video embeds without inventory + notice review. Prefer self-hosted assets.

---

## Data-minimization checklist (to verify at runtime)

- [ ] No Aadhaar/PAN/bank account/salary in analytics events, URLs, push text, email subject lines, or error logs
- [ ] No attendance selfie/photo bytes sent to any third party (only Supabase Storage, server-side)
- [ ] No HR details in error logs (global handler is prod-safe: `err.message` only when `NODE_ENV=development`)
- [ ] Email bodies/password-reset messages contain no salary/bank/PAN data
- [ ] Push notification text contains no PII (subscription endpoint is opaque)
