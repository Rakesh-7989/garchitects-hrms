# Privacy Policy (Outline) — G-Architects HRMS

**Status:** Draft template — NOT for publication until Indian counsel validates  
**Owner:** Product owner + HR policy owner + privacy/legal reviewer  
**Version:** v0.1 (draft)  
**Applies to:** garchitects-hrms (employee portal), https://garchitects-hrms.vercel.app

---

## 1. Introduction & responsible party
- **Controller:** G Architects, Hyderabad, Telangana, India (registered office address on payslip header)
- **Contact / grievance officer:** name + email to be inserted by counsel
- **Effective date:** [to be set on publication]
- **Version history:** v0.1 draft; versioned on each material change
- **How changes are communicated:** notice in portal + email to registered work email

---

## 2. Data categories we collect (mirrors docs/DATA_INVENTORY.md)

| Category | Examples | Mandatory or optional |
|---|---|---|
| Identity & contact | name, employee ID, work/personal email, phone, photo, DOB, gender, address, emergency contact | Mixed |
| Employment & access | department, designation, manager, joining/last-working date, role, status, password hash, token version, reset OTP records | Mixed |
| Sensitive statutory & banking | PAN, Aadhaar, passport, bank account/IFSC, UAN/PF/ESI, salary components, deductions, loans/advances | Optional unless statutory |
| Attendance & leave | check-in/out, breaks, location (at check-in only), selfie photo, leave/WFH dates & reasons, approvals | Mixed |
| Work & project | project assignment, daily updates, task descriptions, documents, tickets, handovers | Mixed |
| Operational/technical | audit actions, timestamps, IP address, push subscription endpoints, notification read state | Technical |

> No field is shared with third parties except as listed in §5. Sensitive fields are restricted sharply.

---

## 3. Purposes & lawful basis
- **Employment administration** (payroll, attendance, leave, benefits): performance of the employment relationship / legal obligation
- **Authentication & account security** (login, password reset, session revocation): legitimate interest / legal obligation
- **Attendance verification** (selfie at check-in, location check at invocation only): consent where not required by employment; otherwise employment necessity
- **Statutory compliance** (PF/ESI/TDS): legal obligation
- **Org communication** (announcements, tickets, notifications): legitimate interest / employment relationship

> Employment processing may rest on a basis other than consent. Consent is used only where genuinely optional (blueprint §4). Optional processing is never bundled into mandatory acceptance.

---

## 4. Consent, acknowledgement & withdrawal
- Separate records for: (a) notice acknowledgement, (b) optional consent-based processing, (c) optional features (push notifications)
- Consent table: notice_key, notice_version, purpose, choice (granted/declined/withdrawn/acknowledged), timestamp, method, locale, withdrawal timestamp; append-only audit event
- Withdrawal: accessible via My Profile; effect explained per purpose; refusal does not silently block unrelated HRMS functions
- Camera/location for attendance: requested only at check-in invocation, never in background; documented exception/manual-review workflow if permission is refused
- No pre-checked optional boxes; no fabricated consent

---

## 5. Recipients & processors
| Recipient | Purpose | Data shared | Region |
|---|---|---|---|
| Supabase (Postgres + Storage) | Database, attendance photo storage | Full HR data / photo bytes | ap-south-1 (project) |
| Vercel | Hosting, functions, logs | Function/log metadata | Vercel infra |
| SMTP email provider | Reset OTP, notifications | Recipient address + email body (no PAN/Aadhaar/bank/salary) | Provider-dependent |
| Web-push service | Push notifications | Push endpoint/subscription (opaque) | VAPID |

- No data is sold. No advertising. No analytics pixels.
- Google Maps link: location is sent to Google **only** if the employee clicks "View on Map" from an attendance record — not in the background.

---

## 6. Retention & deletion (summary; full schedule in docs/POLICY_RETENTION_DELETION.md)
- Attendance photos: short-term; auto-purged expired/viewed
- Reset OTPs: 5 minutes, single-use
- Audit logs: append-only, retained per legal requirement
- Payroll/statutory: per accounting/tax law
- Employee records: employment duration + statutory tail

---

## 7. User rights
- Access, correction, withdrawal of consent, grievance/escalation contact
- Requests via HR contact; identity verified before disclosure

---

## 8. Security measures
- Server-side role-based access control (RBAC), JWT with token_version revocation, bcrypt password hashing, rate-limited auth endpoints, TLS in transit, private storage buckets for photos/documents, authorized downloads, audit logging of sensitive actions
- No sensitive field values or tokens written to audit logs; no secrets in client bundle

---

## 9. Children / cross-border
- Not a service for children; no knowingly-collected child data
- Primary hosting in India (ap-south-1); email/push processors may be outside India — disclosed above

---

## 10. Grievance contact
- Name, email, and response timeline to be inserted by counsel

*This outline is an engineering draft, not legal advice. Indian counsel must validate before publication.*
