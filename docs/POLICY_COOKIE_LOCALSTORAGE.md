# Cookie & Local Storage Notice — G-Architects HRMS

**Status:** Draft — pending Indian counsel review before publication  
**Version:** v0.1  
**Effective Date:** [To be set on publication]  
**Applies to:** garchitects-hrms employee portal (https://garchitects-hrms.vercel.app)

---

## 1. Introduction

This Cookie & Local Storage Notice explains how G-Architects HRMS ("we", "us", "our") uses cookies, localStorage, sessionStorage, and similar technologies on our employee portal. It describes what these technologies are, what data they collect, and how you can control them.

---

## 2. What Are Cookies and Similar Technologies?

- **Cookies:** Small text files stored on your device by your web browser when you visit a website.
- **localStorage / sessionStorage:** Browser storage APIs that store data on your device for use by web applications. sessionStorage is cleared when the browser session ends; localStorage persists until cleared.
- **Service Worker Cache:** Browser cache used by Progressive Web Apps (PWAs) to serve content offline and improve load times.

---

## 3. Technologies We Use

### 3.1 Authentication Token (Essential)

| Technology | Name | Purpose | Provider | Expiry | Essential? |
|------------|------|---------|----------|--------|------------|
| localStorage | `token` | JWT authentication token for API access | G-Architects HRMS | Until logout or expiration | Yes |
| localStorage | `user` | Serialized user profile (role, name, employee ID) | G-Architects HRMS | Until logout or expiration | Yes |

These are **strictly essential** for the HRMS to function. Without them, you cannot log in or access any employee features. You cannot opt out of these.

### 3.2 Service Worker Cache (Essential)

| Technology | Name | Purpose | Provider | Expiry | Essential? |
|------------|------|---------|----------|--------|------------|
| Service Worker | `garchitects-hrms-v13` | PWA cache for offline access and faster loading | G-Architects HRMS | Until updated or cleared | Yes |

This is **essential** for the PWA to function offline and load quickly. It never caches `/api/` endpoints. You cannot opt out of this.

### 3.3 Analytics / Marketing

| Technology | Name | Purpose | Provider | Expiry | Essential? |
|------------|------|---------|----------|--------|------------|
| — | — | — | — | — | — |

**We do not use** analytics cookies, advertising pixels, third-party tracking, or social media embeds. No non-essential cookies are set.

### 3.4 External Resources

| Resource | Purpose | Provider | Data Sent? |
|----------|---------|----------|------------|
| Font Awesome CSS | Icons library | cdnjs.cloudflare.com | Browser metadata (IP, User-Agent) only — no HR data |
| Google Maps link | View check-in location | Google | Lat/long coordinates sent **only** when you click "View on Map" — not automatic |

These are **third-party links**, not embedded trackers. No data is sent unless you click the link.

---

## 4. Your Choices

### Essential Technologies
Authentication tokens, service worker cache, and session management are essential for the HRMS to function. You cannot opt out of these. If you block all cookies/localStorage, you will not be able to log in or use the HRMS.

### Non-Essential Technologies
We do **not** use non-essential cookies, analytics, advertising, or tracking pixels. No consent banner is displayed because there is nothing to consent to.

### Browser Controls
You can:
- Clear localStorage and cookies at any time via your browser settings (this will log you out)
- Block third-party cookies in your browser (does not affect our first-party authentication)
- Use private/incognito browsing (data is cleared when the session ends)

---

## 5. Data Collected

We do **not** store the following in cookies, localStorage, or service worker cache:
- PAN, Aadhaar, passport numbers
- Bank account details
- Salary information
- Attendance selfies or photos
- Leave reasons or HR details
- Any other sensitive personal data

The only data stored client-side is:
- Your authentication token (JWT)
- Your user profile (name, employee ID, role)
- Cached static assets (CSS, JS, images) for offline access

---

## 6. Contact

If you have questions about this Cookie & Local Storage Notice, contact:
**HR Contact:** [Name and email to be inserted by counsel]  
**Grievance Officer:** [Name and email to be inserted by counsel]

---

## 7. Changes to This Notice

We may update this notice from time to time. Changes will be communicated via the portal and/or email to your registered work email address. The effective date will be updated accordingly.

---

*This notice is an engineering draft. Indian counsel must validate before publication.*
