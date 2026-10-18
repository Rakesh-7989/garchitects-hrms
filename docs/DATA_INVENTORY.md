# Data Inventory — G-Architects HRMS

**Status:** Draft (Phase 2 preparation)  
**Source:** `server/schema.sql` (canonical schema), route handlers read during deep-dive  
**Per-field status:** `confirmed collected` = traced to a form/route; `schema available only` = column exists but not yet confirmed populated/sent; `not used` = no consumer found

> Per blueprint §3: a column means the app *can* store that category; it does not prove every field is populated, required, or sent to a third party. Actual collection must be confirmed by tracing forms, route handlers, logs, network requests, storage and vendor settings before publishing notices.

---

## A. Identity & contact

| Table.field | Source / form | Required? | Purpose | Who can view / edit | Status |
|---|---|---|---|---|---|
| employees.employee_id | HR creates; login identifier | Yes | Unique employee identifier | Employee (own), HR, Admin | schema available only |
| employees.first_name / last_name | Profile form | Yes | Display name | Employee (own), HR, Admin | schema available only |
| employees.email | Login + notifications | Yes | Work email, auth ID | Employee (own), HR, Admin | schema available only |
| employees.phone | Profile form | No | Contact | Employee (own), HR, Admin | schema available only |
| employees.personal_email | Profile / forgot-password delivery | No | Password reset delivery (fallback) | Employee (own), HR, Admin | schema available only |
| employees.profile_photo | Upload | No | Profile avatar | Employee (own), HR, Admin | schema available only |
| employees.date_of_birth | Profile form | No | Statutory / age | Employee (own), HR, Admin | schema available only |
| employees.gender | Profile form | No | Leave-type eligibility (maternity/paternity) | Employee (own), HR, Admin | schema available only |
| employees.address / permanent_address | Profile form | No | Correspondence | Employee (own), HR, Admin | schema available only |
| employees.emergency_contact / emergency_contact_name | Profile form | No | Emergency | Employee (own), HR, Admin | schema available only |
| employees.marital_status, languages_spoken, qualification, specialization | Profile form | No | HR records | Employee (own), HR, Admin | schema available only |
| employees.blood_group | Profile form | No | Emergency medical | Employee (own), HR, Admin | schema available only |

---

## B. Employment & access

| Table.field | Source / form | Required? | Purpose | Who can view / edit | Status |
|---|---|---|---|---|---|
| employees.department_id / designation_id | HR assigns | Yes | Org structure, reporting | Employee (own), HR, Admin | schema available only |
| employees.reporting_manager_id / secondary_reporting_manager_id | HR assigns | Yes | Approval routing, tree scope | Employee (own), Manager (tree), HR, Admin | schema available only |
| employees.joining_date / last_working_day | HR sets | Yes | Tenure, service calcs | Employee (own), HR, Admin | schema available only |
| employees.employment status + status_reason | HR changes | Yes | Active/paused/terminated/etc. | HR, Admin (write); all (read own) | schema available only |
| employees.role | HR/Admin sets | Yes | RBAC | Admin (write); all (read own) | schema available only |
| employees.password_hash | Auth system | Yes | Credential | Server only (never returned) | confirmed (auth route) |
| employees.token_version | Auth system | Yes | Session revocation on reset | Server only | confirmed (verifyToken) |
| employees.must_change_password | Admin sets | No | Force temp-password change | Admin (write); employee (own change) | schema available only |
| password_reset_otps.email / otp / reset_token / expires_at | Forgot-password flow | Yes | Single-use password reset | Server only; email delivery via SMTP | confirmed (auth route) |
| audit_logs.actor_id / action / ip_address / created_at | System writes | Yes | Security trail | Admin only | confirmed (auditLogs route) |

---

## C. Sensitive statutory & banking data (restrict sharply)

| Table.field | Source / form | Required? | Purpose | Who can view / edit | Status |
|---|---|---|---|---|---|
| employees.pan_number | Profile / onboarding | No (statutory) | Payroll tax (TDS) | HR, Admin; employee (own, masked?) | schema available only |
| employees.aadhaar_number | Profile / onboarding | No (statutory) | Identity verification | HR, Admin | schema available only |
| employees.passport_number | Profile / onboarding | No | ID (travel/client work) | HR, Admin | schema available only |
| employees.bank_name / bank_branch / bank_account / bank_ifsc | Profile / payroll setup | No (payroll) | Salary credit | HR, Admin; employee (own) | schema available only |
| employees.uan_number / pf_number / esi_number | Profile / payroll setup | No (statutory) | PF/ESI contributions | HR, Admin; employee (own) | schema available only |
| employees.salary / basic_salary / hra / conveyance / medical / special_allowance / other_allowance / incentive / bonus / extra_work | Admin sets | Yes (payroll) | Compensation | HR, Admin (write); employee (own view) | schema available only |
| employees.pf / esi / professional_tax / income_tax / loan_deduction / advance_salary / other_deduction / employer_pf / employer_esi / employer_contribution | Admin sets | Yes (payroll) | Deductions / employer share | HR, Admin; employee (own view) | schema available only |
| payroll.* (net_salary, gross_salary, total_deductions, allowances, deductions, …) | Payroll run | Yes | Payslip / payment record | HR, Admin; employee (own payslip) | schema available only |

> These are the highest-sensitivity fields. Access must be restricted sharply (blueprint §3): HR/Admin write, employee own-view, never in analytics/push/email subjects/error logs.

---

## D. Attendance & leave

| Table.field | Source / form | Required? | Purpose | Who can view / edit | Status |
|---|---|---|---|---|---|
| attendance.check_in / check_out | Check-in/out action | Yes | Worked time | Employee (own), Manager (tree), HR, Admin | confirmed (attendance route) |
| attendance.break_start / break_end / break_log | Break action | No | Break tracking | Employee (own), Manager (tree), HR, Admin | confirmed (break-finalize feature) |
| attendance.status | Auto/set | Yes | Present/absent/late/wfh/holiday | Employee (own), Manager (tree), HR, Admin | confirmed |
| attendance.check_in_location / check_out_location | Check-in/out (permission) | No | Location check (attendance) | Employee (own), Manager (tree), HR, Admin | schema available only |
| attendance.photo_token / photo_token_checkout | Selfie at check-in | No | Attendance verification photo | Employee (own), HR/Admin (photo serve) | confirmed (photo route) |
| attendance.auto_checkout / auto_checkout_at / checkout_miss_reason | System + employee explanation | No | Missed-checkout handling | Employee (own), Manager (tree), HR, Admin | confirmed |
| attendance_photos.photo (BYTEA) / token / expires_at | Selfie upload | No | Attendance photo storage | HR/Admin via signed/authorized URL | confirmed (storage.js) |
| leave_applications.start_date / end_date / reason / status | Leave application | Yes | Leave request | Employee (own), Manager/HR (approve), Admin | confirmed (leave route) |
| wfh_requests.start_date / end_date / reason / status | WFH application | Yes | WFH request | Employee (own), Manager/HR (approve), Admin | confirmed (wfh route) |
| holidays.* | HR sets | Yes | Holiday calendar | All (read) | schema available only |

---

## E. Work & project data

| Table.field | Source / form | Required? | Purpose | Who can view / edit | Status |
|---|---|---|---|---|---|
| projects.* / project_units.* | Admin creates | Yes | Project registry | Admin (write); scoped reads by role | confirmed (projects route) |
| project_employees.* | Assignment | Yes | Employee ↔ project/unit | Manager/lead (tree), employee (own) | confirmed |
| project_daily_updates.description / hours / task_cat | Employee daily log | Yes | Work log | Employee (own), Manager (tree), Admin | confirmed |
| project_status_updates.* | Lead/manager posts | Yes | Progress notes | Scoped by role | confirmed |
| work_assignments.title / description / status / blocked_reason / cancel_reason | Manager assigns | Yes | Task assignment | Assigner, assignee, manager | confirmed (WA v2) |
| daily_work_logs.title / description | Employee self-report | Yes | Self-reported work | Employee (own), Manager (tree), Admin | confirmed |
| project_documents.* / file_url | Upload | No | Project docs (drawings, contracts) | Scoped by role | confirmed |
| support_tickets.subject / description / category | Employee raises | Yes | Support request | Employee (own), HR/Admin (respond) | confirmed |
| project_access_requests / project_access_grants | Request flow | Yes | Read access to non-assigned projects | Requester, approvers (leads/manager/admin) | confirmed |
| team_transfer_requests / team_handovers | Governance | Yes | Cross-team movement / cover | Leads, manager, HR, Admin | confirmed |

---

## F. Operational / technical

| Table.field | Source / form | Required? | Purpose | Who can view / edit | Status |
|---|---|---|---|---|---|
| push_subscriptions.endpoint / subscription / user_agent | PWA subscribe | No | Web-push notifications | Employee (own), server (send) | confirmed (push route) |
| user_notifications.* | System creates | No | In-app notice feed | Employee (own) | confirmed (notifications route) |
| announcements.* | Admin/HR posts | Yes | Org-wide broadcast | Role-scoped audience | confirmed |
| company_settings.* | Admin sets | Yes | Office time, currency, timezone | Admin | confirmed |

---

## Retention & deletion notes (to be finalized by counsel, Phase 2)

| Category | Suggested retention | Deletion / anonymization |
|---|---|---|
| Attendance photos | Short (e.g. 30–90 days) | Purge expired/viewed (existing `purgeExpiredPhotos` job) |
| Reset OTPs | 5 minutes + single-use | Mark used after consumption; purge expired |
| Audit logs | Long (legal requirement) | Append-only; never delete via app code |
| Payroll / statutory | Per accounting/tax law (multi-year) | Anonymize on offboarding where lawful |
| Employee records | Duration of employment + statutory tail | Offboarding flow; archive then purge per schedule |
| Push endpoints | Until user logs out / device inactive | Remove on logout / stale-endpoint cleanup |

---

## Fields needing investigation (not yet traced to a form)

- `check_in_location` / `check_out_location` — confirm whether GPS coordinates are stored or only a permission/value is checked (blueprint §4: do not request location in background)
- `attendance_photos.photo` — confirm the selfie is stored in Supabase Storage private bucket + authorized download (not public bucket)
- `personal_email` — confirm it's only used for reset delivery, not marketing
- Any field marked `schema available only` must be traced before the Privacy Policy is published
