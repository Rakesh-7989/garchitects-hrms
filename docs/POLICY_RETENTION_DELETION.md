# Data Retention & Deletion Schedule — G-Architects HRMS

**Status:** Draft — pending Indian counsel review before publication  
**Version:** v0.1  
**Effective Date:** [To be set on publication]  
**Owner:** HR Policy Owner + Technical Owner  
**Applies to:** garchitects-hrms employee portal and all associated data stores

---

## 1. Introduction

This Data Retention & Deletion Schedule defines how long G-Architects HRMS ("we", "us", "our") retains different categories of employee and operational data, and how that data is deleted or anonymized when no longer needed. It is designed to comply with applicable Indian laws, including labor laws, tax laws, and the Digital Personal Data Protection Act, 2023 (DPDP Act) as applicable.

---

## 2. Retention Categories

### 2.1 Employee Records

| Data Category | Examples | Retention Period | Deletion / Anonymization |
|--------------|----------|-----------------|-------------------------|
| Identity & contact | Name, employee ID, email, phone, address, DOB, gender, photo | Employment duration + 5 years after last working day | Anonymize (remove identifiers) after 5 years; full deletion on request where legally permissible |
| Employment details | Department, designation, manager, joining date, status | Employment duration + 5 years | Anonymize after 5 years |
| Statutory & banking | PAN, Aadhaar, passport, bank account, UAN/PF/ESI | As required by tax/labor law (typically 7-8 years) | Secure deletion after statutory period |
| Salary & payroll | Salary components, payroll records, payslips | As required by tax law (typically 7-8 years) | Secure deletion after statutory period |

### 2.2 Attendance & Leave

| Data Category | Examples | Retention Period | Deletion / Anonymization |
|--------------|----------|-----------------|-------------------------|
| Check-in/out records | Times, status, break times | 3 years | Purge after 3 years |
| Attendance photos | Selfie at check-in | 30 days (auto-purged) | Auto-purge job deletes expired/viewed photos daily |
| Leave applications | Dates, reason, status | 3 years | Purge after 3 years |
| WFH requests | Dates, reason, status | 3 years | Purge after 3 years |
| Missed checkout reason | Employee explanation | 3 years | Purge after 3 years |

### 2.3 Authentication & Security

| Data Category | Examples | Retention Period | Deletion / Anonymization |
|--------------|----------|-----------------|-------------------------|
| Password reset OTPs | OTP code, expiry | 5 minutes (single-use) | Mark used immediately after consumption; purge expired OTPs daily |
| Reset tokens | Token, expiry | 5 minutes | Revoked on use or expiry |
| JWT tokens | Session token | Until logout or expiration (7 days) | Revoked on token_version bump (password change) |
| Audit logs | Actor, action, timestamp, IP | 5 years (append-only) | Append-only; never deleted via app code |

### 2.4 Work & Project Data

| Data Category | Examples | Retention Period | Deletion / Anonymization |
|--------------|----------|-----------------|-------------------------|
| Daily work logs | Title, description, hours, date | 3 years | Purge after 3 years |
| Work assignments | Title, status, dates | 3 years | Purge after 3 years |
| Project documents | Drawings, contracts, files | Employment duration + 3 years | Archive then purge |
| Support tickets | Subject, description, status | 3 years | Purge after 3 years |
| Project access requests | Requester, approver, status | 3 years | Purge after 3 years |
| Team transfer requests | Employee, from TL, to TL, status | 3 years | Purge after 3 years |
| Team handovers | Absent TL, cover TL, dates | 3 years | Purge after 3 years |

### 2.5 Operational & Technical

| Data Category | Examples | Retention Period | Deletion / Anonymization |
|--------------|----------|-----------------|-------------------------|
| Push subscriptions | Endpoint, subscription JSON | Until user logs out or endpoint invalid | Remove on logout; purge stale endpoints monthly |
| User notifications | Title, body, read state | 90 days | Purge after 90 days |
| Announcement reads | Employee, announcement, timestamp | Until announcement expires | Purge when announcement expires |
| Daily update reads | Manager, update, timestamp | 90 days | Purge after 90 days |
| Error logs | Error message, timestamp | 30 days | Purge after 30 days (no sensitive data) |

---

## 3. Deletion & Anonymization Process

### 3.1 Automated Purge Jobs

| Job | Frequency | Target |
|-----|-----------|--------|
| Photo purge | Daily (3:00 AM IST) | attendance_photos where expired or viewed |
| OTP purge | Daily | password_reset_otps where expired |
| Announcement expiry | Daily (4:00 AM IST) | announcements where expires_at passed |
| Handover expiry | Daily (4:30 AM IST) | team_handovers where end_date passed |

### 3.2 Manual Deletion

- **Employee offboarding:** On termination, employee data is retained per statutory requirements (payroll: 7-8 years; other records: 5 years). Access is revoked immediately.
- **Data subject request:** Employees may request correction or deletion of their personal data. Requests are reviewed by HR and processed within 30 days where legally permissible.
- **Account deactivation:** When an account is set to inactive/paused/terminated, login is immediately blocked. Data is retained per retention schedule.

### 3.3 Anonymization

When data reaches the end of its retention period:
- Identifying fields (name, email, employee ID, phone) are replaced with pseudonyms or deleted
- Aggregated statistical data may be retained for reporting
- Audit logs are append-only and are never deleted via application code

---

## 4. Legal Holds

Data subject to a legal hold (litigation, investigation, audit) is exempt from deletion until the hold is released. HR and legal teams jointly manage legal holds.

---

## 5. Contact

**HR Contact:** [Name and email to be inserted by counsel]  
**Data Protection / Grievance Officer:** [Name and email to be inserted by counsel]

---

## 6. Changes to This Schedule

This schedule is reviewed annually or when laws change. Changes are communicated via the portal and/or email.

---

*This document is an engineering draft. Indian counsel must validate before publication.*
