# Vendor / Data Processing Register — G-Architects HRMS

**Status:** Draft — pending review before publication  
**Version:** v0.1  
**Effective Date:** [To be set on publication]  
**Owner:** Technical Owner  
**Applies to:** garchitects-hrms employee portal and all associated services

---

## 1. Introduction

This Vendor / Data Processing Register lists all third-party vendors and subprocessors that G-Architects HRMS ("we", "us", "our") engages to process employee and organizational data. It includes the purpose, categories of data shared, hosting region, retention, and security terms for each vendor.

This register is maintained internally and reviewed before adding any new third-party embed or API.

---

## 2. Third-Party Vendors

### 2.1 Supabase (Database + Storage)

| Field | Details |
|-------|---------|
| **Purpose** | PostgreSQL database hosting and file storage for attendance photos and employee documents |
| **Data Shared** | All HR data (employees, payroll, attendance, leave, documents, audit logs, etc.) |
| **Hosting Region** | ap-south-1 (Mumbai, India) |
| **Subprocessors** | Supabase infrastructure providers (AWS, etc.) |
| **Access Controls** | Service-role key stored server-side only; never in frontend; RLS enabled on sensitive tables |
| **Retention** | Per Data Retention & Deletion Schedule |
| **Deletion Path** | API-based deletion; bucket purge jobs for expired photos |
| **Contract / DPA** | Supabase Terms of Service |
| **Data Leaves India?** | No (ap-south-1 region) |

### 2.2 Vercel (Hosting + Serverless Functions)

| Field | Details |
|-------|---------|
| **Purpose** | Hosting of frontend and backend API functions |
| **Data Shared** | Function logs, deployment metadata; no HR data in logs |
| **Hosting Region** | Vercel infrastructure (US-based) |
| **Subprocessors** | Vercel infrastructure providers |
| **Access Controls** | Environment variables stored server-side; no secrets in frontend |
| **Retention** | Logs retained per Vercel platform policy |
| **Deletion Path** | Logs purged per Vercel retention policy |
| **Contract / DPA** | Vercel Terms of Service |
| **Data Leaves India?** | Yes (Vercel infrastructure is US-based; application code and logs may transit through US) |

### 2.3 SMTP Email Provider (Nodemailer)

| Field | Details |
|-------|---------|
| **Purpose** | Sending password-reset OTP emails and notifications |
| **Data Shared** | Recipient email address, email body (no PAN/Aadhaar/bank/salary) |
| **Hosting Region** | Provider-dependent (configured via SMTP_HOST env var) |
| **Subprocessors** | Email provider infrastructure |
| **Access Controls** | SMTP credentials stored server-side only |
| **Retention** | Per email provider retention policy |
| **Deletion Path** | Emails deleted per provider retention policy |
| **Contract / DPA** | Email provider Terms of Service |
| **Data Leaves India?** | Depends on SMTP provider configuration |

### 2.4 Web Push (VAPID / Browser Push Service)

| Field | Details |
|-------|---------|
| **Purpose** | Push notifications for check-in reminders, leave approvals, announcements |
| **Data Shared** | Push endpoint URL, subscription JSON (opaque identifier); no PII |
| **Hosting Region** | Browser-dependent (user's browser and push service) |
| **Subprocessors** | Browser vendor (Google, Mozilla, Apple, etc.) |
| **Access Controls** | VAPID private key stored server-side only |
| **Retention** | Until user unsubscribes or endpoint becomes invalid |
| **Deletion Path** | Unsubscribe endpoint removes subscription |
| **Contract / DPA** | Browser vendor terms |
| **Data Leaves India?** | Depends on user's location and push service |

### 2.5 Font Awesome (Icons CSS)

| Field | Details |
|-------|---------|
| **Purpose** | Icons library for UI |
| **Data Shared** | Browser metadata (IP, User-Agent) on page load; no HR data |
| **Hosting Region** | cdnjs.cloudflare.com (Global CDN) |
| **Subprocessors** | Cloudflare |
| **Access Controls** | None required (public resource) |
| **Retention** | Browser cache |
| **Deletion Path** | Browser cache cleared by user |
| **Contract / DPA** | Cloudflare Terms of Service |
| **Data Leaves India?** | Yes (Global CDN) |

### 2.6 Google Maps (User-Click Link Only)

| Field | Details |
|-------|---------|
| **Purpose** | View check-in/check-out location on map |
| **Data Shared** | Lat/long coordinates **only when user clicks "View on Map"**; not sent in background |
| **Hosting Region** | Google Maps (global) |
| **Subprocessors** | Google |
| **Access Controls** | User-initiated only; `target="_blank" rel="noopener"` |
| **Retention** | Per Google's retention policy |
| **Deletion Path** | Per Google's data deletion controls |
| **Contract / DPA** | Google Terms of Service |
| **Data Leaves India?** | Yes |

---

## 3. Vendors We Do NOT Use

The following are explicitly **not** used in the HRMS:

- Analytics (Google Analytics, Matplotlib, etc.)
- Advertising pixels (Meta, Google Ads, etc.)
- Chat widgets (Intercom, Zendesk chat, etc.)
- Third-party video embeds (YouTube, Vimeo, etc.)
- Social media embeds
- CAPTCHA services
- Customer data platforms (CDP)

---

## 4. Data Minimization Checklist

Before adding any new vendor or embed:

- [ ] Is the vendor necessary for the feature?
- [ ] What is the minimum data required?
- [ ] Is the data category sensitive (PAN, Aadhaar, bank, salary, photos)?
- [ ] Where is the vendor hosted?
- [ ] Does data leave India?
- [ ] Are there subprocessors?
- [ ] Is there a contract/DPA?
- [ ] What is the deletion path?
- [ ] Is the vendor disclosed in this register?

---

## 5. Adding a New Vendor

1. Complete the data minimization checklist above
2. Obtain HR and Technical Owner approval
3. Add entry to this register
4. Update Privacy Policy and Employee Privacy Notice if needed
5. Implement with server-side secrets only (never in frontend)
6. Test on staging before production

---

## 6. Register Review

This register is reviewed:
- Quarterly during normal operations
- Before adding any new vendor or embed
- After any security incident involving a vendor
- Annually as part of the privacy policy review

---

## 7. Contact

**Technical Owner:** [Name and email to be inserted by counsel]  
**Vendor Management:** [Name and email to be inserted by counsel]

---

*This document is an engineering draft. Indian counsel must validate before publication.*
