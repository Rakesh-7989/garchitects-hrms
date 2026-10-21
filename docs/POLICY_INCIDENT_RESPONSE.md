# Security & Incident Response Policy — G-Architects HRMS

**Status:** Draft — pending Indian counsel review before publication  
**Version:** v0.1  
**Effective Date:** [To be set on publication]  
**Owner:** Technical Owner + Security Lead  
**Applies to:** garchitects-hrms employee portal, backend API, and associated infrastructure

---

## 1. Introduction

This Security & Incident Response Policy defines how G-Architects HRMS protects employee and organizational data, and how we respond to security incidents. It covers access control, secret management, backup/restore, vulnerability handling, breach triage, and notification procedures.

---

## 2. Access Control

### 2.1 Role-Based Access Control (RBAC)

The HRMS uses role-based access control with the following roles:

| Role | Permissions |
|------|-------------|
| **Admin** | Full access: structure, designation, money-write, settings, permanent delete |
| **HR** | People modules: employees, leave, WFH, documents, attendance reviews; read-only on projects |
| **Manager** | Structure, designation, placement power; scoped to reporting tree + assigned projects |
| **Team Lead** | Scoped to projects/units they lead; placement of reporting tree into led units |
| **Employee** | Own data, daily updates, work assignments; read-only own projects |

Access is enforced **server-side** on every API request. UI hiding is cosmetic only and never the sole authorization check.

### 2.2 Authentication

- Passwords are hashed with bcrypt (minimum 8 characters)
- JWT tokens expire in 7 days
- Token version is bumped on password change, instantly revoking all prior tokens
- Login rate-limited to 10 attempts per 15 minutes per IP
- Password reset OTP is single-use, 5-minute expiry, peppered SHA-256 hash
- Account status (active/inactive/paused/terminated/on_hold/absconded) is verified on every request

### 2.3 Secrets Management

| Secret | Storage | Rotation |
|--------|---------|----------|
| DATABASE_URL | Server-side env (Vercel) | On compromise |
| JWT_SECRET | Server-side env (Vercel) | On compromise |
| SMTP credentials | Server-side env (Vercel) | On compromise |
| SUPABASE_SERVICE_KEY | Server-side env (Vercel) | On compromise |
| CRON_SECRET | Server-side env (Vercel) | On compromise |
| VAPID keys | Server-side env (Vercel) | On compromise |

**Never:** Commit secrets to Git, log them, or expose them in frontend bundles.

---

## 3. Backup & Restore

### 3.1 Backup Schedule

| Backup Type | Frequency | Retention | Location |
|-------------|-----------|-----------|----------|
| Database dump | Daily | 30 days | Encrypted offsite storage |
| Full system | Weekly | 90 days | Encrypted offsite storage |

### 3.2 Restore Testing

Restore procedure is tested quarterly. Restore time objective: < 4 hours.

### 3.3 Backup Contents

- All application data (employees, payroll, attendance, documents, etc.)
- Schema and migrations
- Configuration (non-secret)

**Never backed up:** Secrets, passwords, JWT keys, SMTP credentials

---

## 4. Vulnerability Handling

### 4.1 Dependency Scanning

- `npm audit` run on every CI build
- Critical vulnerabilities block deployment
- Dependencies updated monthly

### 4.2 Security Advisories

- Supabase Security Advisor reviewed monthly
- RLS findings remediated table-by-table
- CORS configuration reviewed quarterly

### 4.3 Penetration Testing

Annual third-party penetration test (when budget permits)

---

## 5. Incident Response

### 5.1 Incident Classification

| Severity | Definition | Examples | Response Time |
|----------|------------|----------|---------------|
| **Critical** | Active data breach, system compromise | Unauthorized data access, credential leak | Immediate (24/7) |
| **High** | Potential data exposure, access control bypass | Misconfigured RLS, broken auth | Same business day |
| **Medium** | Policy violation, minor vulnerability | Missing audit log, weak password | 3 business days |
| **Low** | Information disclosure, cosmetic issue | Error message detail, UI inconsistency | Next release cycle |

### 5.2 Incident Response Team

| Role | Name | Contact |
|------|------|---------|
| Incident Owner | [Name] | [Email/Phone] |
| Technical Lead | [Name] | [Email/Phone] |
| HR/Legal Contact | [Name] | [Email/Phone] |
| Communications | [Name] | [Email/Phone] |

### 5.3 Breach Response Process

1. **Detect:** Identify and confirm the security incident
2. **Contain:** Isolate affected systems, revoke access, change credentials
3. **Assess:** Determine scope, data affected, root cause
4. **Notify:** Inform affected individuals and regulators as required by law
5. **Remediate:** Fix root cause, update controls, retrain staff
6. **Document:** Record incident, actions taken, lessons learned

### 5.4 Breach Notification

Under applicable Indian law (including DPDP Act, 2023), we will notify affected individuals and the Data Protection Board within the legally required timeframe if a breach is likely to cause harm.

Notification includes:
- Nature of the breach
- Data categories affected
- Steps taken to address it
- Steps individuals can take
- Contact for questions

---

## 6. Data Minimization

We do **not** include the following in analytics events, URLs, push notification text, email subject lines, or error logs:
- Aadhaar, PAN, passport numbers
- Bank account details
- Salary information
- Attendance selfies
- Leave reasons
- HR details

---

## 7. Contact

**Security Contact:** [Name and email to be inserted by counsel]  
**Incident Reporting:** [Email to be inserted by counsel]  
**Response Time:** All security reports acknowledged within 24 hours

---

*This document is an engineering draft. Indian counsel must validate before publication.*
