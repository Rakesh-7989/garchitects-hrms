const nodemailer = require('nodemailer');
require('dotenv').config();

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;
    if (process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_USER !== 'your-email@gmail.com') {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: false,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
        return transporter;
    }
    return null;
}

// Sender identity shown to recipients. SMTP_FROM lets the mails come from the
// office address (e.g. garchitects99@gmail.com) while SMTP_USER stays just the
// login credential for the SMTP server. NOTE for Gmail: the From address must
// be added as a "Send mail as" alias in the SMTP account, otherwise Gmail
// rewrites it back to the login address.
function getFromAddress() {
    const from = (process.env.SMTP_FROM || '').trim();
    if (from) return `"G-Architects HRMS" <${from}>`;
    return `"G-Architects HRMS" <${process.env.SMTP_USER}>`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

// Shared branded shell so every outgoing mail looks consistent and
// professional across Gmail / Outlook / Apple Mail. Solid bgcolor
// attributes back up gradients and rounded corners for clients that
// strip CSS.
function baseEmail({ preheader, headerTitle, headerSubline, bodyHtml }) {
    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6" style="background:#f3f4f6;width:100%;">
        <tr><td align="center" style="padding:32px 12px;">
            <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:520px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(17,24,39,0.08);">
                <tr>
                    <td bgcolor="#4F46E5" background="linear-gradient(135deg,#4F46E5 0%,#9333EA 100%)" style="background-color:#4F46E5;background-image:linear-gradient(135deg,#4F46E5 0%,#9333EA 100%);padding:24px 28px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                            <td style="font-size:21px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">G-Architects<span style="font-weight:400;">&nbsp;HRMS</span></td>
                            <td align="right" style="font-size:11px;font-weight:700;color:#ffffff;background:rgba(255,255,255,0.22);padding:5px 14px;border-radius:999px;white-space:nowrap;">${headerTitle}</td>
                        </tr>${headerSubline ? `
                        <tr><td colspan="2" style="padding-top:9px;font-size:12px;font-weight:600;color:rgba(255,255,255,0.9);letter-spacing:1.5px;text-transform:uppercase;">${headerSubline}</td></tr>` : ''}</table>
                    </td>
                </tr>
                <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px 30px 26px;font-size:14px;line-height:1.7;color:#374151;">${bodyHtml}</td></tr>
                <tr>
                    <td bgcolor="#f9fafb" style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:18px 30px;text-align:center;">
                        <div style="font-size:12px;font-weight:700;color:#111827;letter-spacing:0.3px;">G Architects</div>
                        <div style="font-size:11px;color:#9CA3AF;margin-top:3px;">Human Resource Management System</div>
                        <div style="font-size:10px;color:#c2c7cf;margin-top:8px;">This is an automated message &mdash; please do not reply directly to this email.</div>
                    </td>
                </tr>
            </table>
        </td></tr>
    </table>
</body>
</html>`;
}

// Parse "payslip_<emp>_<month>_<year>.pdf" into parts.
function parsePayslipFilename(filename) {
    try {
        const m = filename.replace(/^payslip_/, '').replace(/\.pdf$/i, '').split('_');
        const month = parseInt(m[1], 10);
        const year = m[2];
        if (month >= 1 && month <= 12 && /^\d{4}$/.test(year || '')) {
            return { emp: m[0] || '', month, year };
        }
    } catch (e) { /* fall through */ }
    return null;
}

// Human-friendly attachment name: Payslip_EMP003_August_2026.pdf
// empCode wins over whatever id sits inside the internal filename.
function prettyPayslipFilename(filename, empCode) {
    const p = parsePayslipFilename(filename);
    if (!p) return filename;
    return `Payslip_${empCode || p.emp}_${MONTHS[p.month - 1]}_${p.year}.pdf`;
}

// Send a payslip PDF as an email attachment. Returns { success, reason } so
// callers can report a clean message when mail is not configured.
// meta: { name, empId, net } - optional personalisation shown in the mail.
async function sendPayslipEmail(email, filename, pdfBuffer, meta) {
    meta = meta || {};
    const mailTransporter = getTransporter();
    if (!mailTransporter) {
        return { success: false, reason: 'Email service not configured. Set SMTP_USER / SMTP_PASS in .env' };
    }
    const parsed = parsePayslipFilename(filename);
    const period = parsed ? `${MONTHS[parsed.month - 1]} ${parsed.year}` : 'this month';
    const empId = meta.empId || (parsed ? parsed.emp : '') || '';
    const attachName = prettyPayslipFilename(filename, empId);
    const greetName = meta.name ? meta.name.split(' ')[0] : '';
    const subject = `Payslip - ${empId ? empId + ' - ' : ''}${period} | G-Architects HRMS`;
    const html = baseEmail({
        preheader: `Your salary payslip for ${period} is attached.`,
        headerTitle: 'PAYSLIP',
        headerSubline: `${empId ? empId + ' &bull; ' : ''}${period}`,
        bodyHtml: `
            <p style="margin:0 0 6px;font-size:16px;font-weight:600;color:#111827;">${greetName ? 'Hi ' + greetName + ',' : 'Hello,'}</p>
            <p style="margin:0 0 20px;">Your salary payslip for <strong>${period}</strong> is ready and attached to this email as a PDF document.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f9fafb" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:18px;"><tr>
                <td style="padding:14px 10px;text-align:center;width:33%;border-right:1px solid #e5e7eb;">
                    <div style="font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1px;">Employee ID</div>
                    <div style="font-size:13px;font-weight:700;color:#111827;margin-top:4px;">${empId || '-'}</div>
                </td>
                <td style="padding:14px 10px;text-align:center;width:33%;border-right:1px solid #e5e7eb;">
                    <div style="font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1px;">Period</div>
                    <div style="font-size:13px;font-weight:700;color:#111827;margin-top:4px;">${period}</div>
                </td>
                <td style="padding:14px 10px;text-align:center;width:34%;">
                    <div style="font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1px;">Net Salary</div>
                    <div style="font-size:13px;font-weight:700;color:#059669;margin-top:4px;">${meta.net != null ? '&#8377;' + Number(meta.net).toLocaleString('en-IN') : '-'}</div>
                </td>
            </tr></table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2ff" style="background:#eef2ff;border-left:4px solid #4F46E5;border-radius:6px;margin-bottom:20px;"><tr>
                <td style="padding:12px 16px;font-size:13px;color:#3730a3;"><strong>&#128206; Attached:</strong> ${attachName}</td>
            </tr></table>
            <p style="margin:0 0 6px;font-size:13px;color:#6B7280;">Please review the details carefully. If you notice any discrepancy in your attendance, earnings or deductions, reach out to the HR / Payroll team so we can correct it promptly.</p>
            <p style="margin:22px 0 0;">Best regards,<br><strong>G-Architects HRMS &ndash; Payroll Team</strong></p>
        `
    });
    const text = `Hello,\n\nYour salary payslip for ${period} is attached as a PDF (${attachName}).\n\nPlease review the details. For any discrepancy contact the HR / Payroll team.\n\nBest regards,\nG-Architects HRMS - Payroll Team\nG Architects`;
    try {
        await mailTransporter.sendMail({
            from: getFromAddress(),
            to: email,
            subject,
            text,
            html,
            attachments: [{
                filename: attachName,
                content: pdfBuffer,
                contentType: 'application/pdf'
            }]
        });
        return { success: true, to: email };
    } catch (error) {
        console.error('Failed to send payslip email:', error.message);
        return { success: false, reason: error.message };
    }
}

async function sendOTPEmail(email, otp, meta) {
    meta = meta || {};
    const mailTransporter = getTransporter();
    if (!mailTransporter) {
        return true;
    }
    // Show the employee ID in the copy when we have it - it is less
    // sensitive than the email address and easier to recognise.
    const accountLabel = meta.empId || email;
    const subject = `Your G-Architects HRMS verification code: ${otp}`;
    const html = baseEmail({
        preheader: `Use code ${otp} to reset your password. Valid for 5 minutes.`,
        headerTitle: 'SECURITY CODE',
        headerSubline: '',
        bodyHtml: `
            <p style="margin:0 0 6px;font-size:16px;font-weight:600;color:#111827;">Hello,</p>
            <p style="margin:0 0 20px;">We received a request to reset the password for your G-Architects HRMS account (<strong>${accountLabel}</strong>). Use the one-time verification code below to continue.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                <td align="center" bgcolor="#eef2ff" style="background:#eef2ff;padding:22px 16px;border:2px dashed #4F46E5;border-radius:12px;">
                    <div style="font-size:11px;font-weight:600;color:#6366F1;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px;">Verification Code</div>
                    <span style="font-size:34px;line-height:1;font-weight:700;color:#4F46E5;letter-spacing:10px;font-family:'Consolas','Courier New',monospace;text-indent:10px;">${otp}</span>
                </td>
            </tr></table>
            <p style="margin:12px 0 20px;text-align:center;font-size:12px;color:#9CA3AF;">Enter this code in the app to reset your password.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:13px;color:#374151;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:20px;">
                <tr><td style="padding:10px 16px;color:#6B7280;border-bottom:1px solid #e5e7eb;">&#9202;&nbsp; Expires in</td><td align="right" style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e5e7eb;">5 minutes</td></tr>
                <tr><td style="padding:10px 16px;color:#6B7280;">&#9993;&nbsp; Requested for</td><td align="right" style="padding:10px 16px;font-weight:700;">${email}</td></tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fffbeb" style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;"><tr>
                <td style="padding:12px 16px;font-size:12px;color:#92400e;"><strong>Security note:</strong> Never share this code with anyone. If you did not request a password reset, you can safely ignore this email &mdash; your current password will remain unchanged.</td>
            </tr></table>
            <p style="margin:22px 0 0;">Best regards,<br><strong>G-Architects HRMS &ndash; Security Team</strong></p>
        `
    });
    const text = `Hello,\n\nWe received a request to reset your G-Architects HRMS password.\n\nVerification code: ${otp}\nExpires in: 5 minutes\n\nNever share this code with anyone. If you did not request a reset, ignore this email - your password will remain unchanged.\n\nBest regards,\nG-Architects HRMS - Security Team\nG Architects`;
    try {
        await mailTransporter.sendMail({
            from: getFromAddress(),
            to: email,
            subject,
            text,
            html
        });
        console.log(`OTP email sent to ${email}`);
        return true;
    } catch (error) {
        console.error('Failed to send email:', error.message);
        return false;
    }
}

// Welcome mail for a brand-new joiner: login credentials + the HRMS URL and
// pointers to complete their profile / onboarding checklist. Sent to the
// personal address when the admin captured one, else to the office address.
// Returns { success, reason } so callers can report status without failing
// the employee creation itself.
async function sendWelcomeEmail(email, meta) {
    meta = meta || {};
    const mailTransporter = getTransporter();
    if (!mailTransporter) {
        return { success: false, reason: 'Email service not configured. Set SMTP_USER / SMTP_PASS in .env' };
    }
    const greetName = meta.name ? meta.name.split(' ')[0] : '';
    const empId = meta.empId || '';
    const tempPassword = meta.tempPassword || '';
    const loginUrl = process.env.APP_URL || 'https://garchitects.in';
    const subject = `Welcome to G-Architects HRMS - Your Account Details${empId ? ' (' + empId + ')' : ''}`;
    const html = baseEmail({
        preheader: `Your G-Architects HRMS account is ready. Log in at ${loginUrl} and complete your profile.`,
        headerTitle: 'WELCOME',
        headerSubline: 'Account Created',
        bodyHtml: `
            <p style="margin:0 0 6px;font-size:16px;font-weight:600;color:#111827;">${greetName ? 'Hi ' + greetName + ',' : 'Hello,'}</p>
            <p style="margin:0 0 20px;">Welcome aboard! Your <strong>G-Architects HRMS</strong> account has been created. Use the credentials below to log in for the first time.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;color:#374151;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:20px;">
                <tr><td style="padding:10px 16px;color:#6B7280;border-bottom:1px solid #e5e7eb;">&#129485;&nbsp; Employee ID</td><td align="right" style="padding:10px 16px;font-weight:700;font-family:'Consolas','Courier New',monospace;border-bottom:1px solid #e5e7eb;">${empId || '-'}</td></tr>
                <tr><td style="padding:10px 16px;color:#6B7280;">&#128273;&nbsp; Temporary Password</td><td align="right" style="padding:10px 16px;font-weight:700;font-family:'Consolas','Courier New',monospace;">${tempPassword || '-'}</td></tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                <td align="center" style="padding:4px 0 22px;">
                    <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#4F46E5 0%,#9333EA 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 38px;border-radius:10px;">Log in to G-Architects HRMS</a>
                    <div style="margin-top:8px;font-size:12px;color:#9CA3AF;">${loginUrl}</div>
                </td>
            </tr></table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2ff" style="background:#eef2ff;border-left:4px solid #4F46E5;border-radius:6px;margin-bottom:20px;"><tr>
                <td style="padding:12px 16px;font-size:13px;color:#3730a3;">
                    <strong>What to do first:</strong>
                    <ol style="margin:8px 0 0;padding-left:18px;">
                        <li>Log in with your Employee ID and the temporary password.</li>
                        <li>You will be asked to set a new password of your choice.</li>
                        <li>Open <strong>My Profile</strong> and fill in your personal, bank and statutory details.</li>
                        <li>Track the remaining steps in <strong>My Onboarding</strong>.</li>
                    </ol>
                </td>
            </tr></table>
            <p style="margin:0 0 6px;font-size:13px;color:#6B7280;">If the button does not work, copy and paste this link into your browser: <a href="${loginUrl}" style="color:#4F46E5;">${loginUrl}</a></p>
            <p style="margin:22px 0 0;">Best regards,<br><strong>G-Architects HRMS &ndash; People Team</strong></p>
        `
    });
    const text = `Hello ${greetName},\n\nWelcome aboard! Your G-Architects HRMS account is ready.\n\nEmployee ID: ${empId}\nTemporary Password: ${tempPassword}\nLogin URL: ${loginUrl}\n\nSteps:\n1. Log in with the credentials above.\n2. Set a new password when prompted.\n3. Fill your details under My Profile.\n4. Track pending steps under My Onboarding.\n\nBest regards,\nG-Architects HRMS - People Team\nG Architects`;
    try {
        await mailTransporter.sendMail({
            from: getFromAddress(),
            to: email,
            subject,
            text,
            html
        });
        console.log(`Welcome email sent to ${email}`);
        return { success: true, to: email };
    } catch (error) {
        console.error('Failed to send welcome email:', error.message);
        return { success: false, reason: error.message };
    }
}

module.exports = { sendOTPEmail, sendPayslipEmail, sendWelcomeEmail };
