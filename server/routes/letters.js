const express = require('express');
const PDFDocument = require('pdfkit');
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Rate limit: letters are generated on demand, keep it modest.
const { rateLimit, clientIp } = require('../utils/rateLimit');
const letterLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyFn: (req) => 'letters:' + clientIp(req),
    message: 'Too many letter requests. Please try again later.'
});

async function getCompanyData() {
    const comp = await query('SELECT * FROM companies LIMIT 1');
    const settings = await query('SELECT setting_key, setting_value FROM company_settings');
    const map = {};
    settings.rows.forEach(s => { map[s.setting_key] = s.setting_value; });
    const c = comp.rows[0] || {};
    return {
        name: c.name || map.company_name || 'G Architects',
        address: c.address || '',
        phone: c.phone || '',
        email: c.email || map.hr_email || '',
        website: c.website || ''
    };
}

const LETTER_TYPES = ['experience', 'employment'];

function fmtDate(d) {
    if (!d) return '—';
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) return String(d);
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
}

function renderLetterPdf(company, employee, letter) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margins: { top: 70, bottom: 70, left: 70, right: 70 }, bufferPages: true });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const W = doc.page.width - 140;

        // Letterhead
        doc.font('Helvetica-Bold').fontSize(20).fillColor('#1F2937').text(company.name, { align: 'center', width: W });
        doc.moveDown(0.15);
        doc.font('Helvetica').fontSize(9).fillColor('#6B7280');
        const headLine = [company.address, company.phone, company.email, company.website].filter(Boolean).join('  |  ');
        if (headLine) doc.text(headLine, { align: 'center', width: W });
        doc.moveDown(0.4);
        doc.moveTo(70, doc.y).lineTo(doc.page.width - 70, doc.y).lineWidth(1.5).strokeColor('#4F46E5').stroke();
        doc.moveDown(1.2);

        // Title
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827')
            .text(letter.title.toUpperCase(), { align: 'center', width: W });
        doc.moveDown(1);

        // Ref / date
        doc.font('Helvetica').fontSize(10).fillColor('#374151');
        doc.text('Ref: garchitects/' + letter.refNo, { continued: false });
        doc.text('Date: ' + fmtDate(new Date()));
        doc.moveDown(1);

        // Salutation
        doc.text('To Whomsoever It May Concern', { underline: false });
        doc.moveDown(0.9);

        // Body
        for (const para of letter.body) {
            doc.font('Helvetica').fontSize(10.5).fillColor('#111827')
                .text(para, { align: 'justify', width: W, lineGap: 3 });
            doc.moveDown(0.8);
        }

        doc.moveDown(1.4);
        doc.font('Helvetica').fontSize(10.5).fillColor('#111827')
            .text('Sincerely,', { width: W });
        doc.moveDown(1.8);
        doc.font('Helvetica-Bold').fontSize(10.5)
            .text(letter.signatoryName || 'Authorized Signatory', { width: W });
        doc.font('Helvetica').fontSize(9).fillColor('#6B7280')
            .text(letter.signatoryRole || 'Human Resources', { width: W });

        // Footer page numbers
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF')
                .text(`Page ${i + 1} of ${range.count}`, 70, doc.page.height - 45, { width: W, align: 'center' });
        }

        doc.end();
    });
}

// @route   POST /api/letters/generate
// @desc    Generate an experience or employment letter PDF for one employee
// @access  Private/Admin
router.post('/generate', verifyToken, isAdmin, letterLimiter, async (req, res) => {
    try {
        const { employee_id, letter_type, last_working_date, signatory_name, signatory_role } = req.body || {};

        if (!employee_id) return res.status(400).json({ success: false, message: 'Employee is required' });
        if (!LETTER_TYPES.includes(letter_type)) {
            return res.status(400).json({ success: false, message: 'letter_type must be experience or employment' });
        }

        const empRes = await query(
            `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.joining_date,
                    des.name AS designation_name, d.name AS department_name
            FROM employees e
            LEFT JOIN designations des ON des.id = e.designation_id
            LEFT JOIN departments d ON d.id = e.department_id
            WHERE e.id = $1`,
            [employee_id]
        );
        const emp = empRes.rows[0];
        if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

        const company = await getCompanyData();
        const fullName = `${emp.first_name} ${emp.last_name}`;
        const refNo = `${String(emp.id).padStart(4, '0')}/${new Date().getFullYear()}`;

        let title, body;
        if (letter_type === 'experience') {
            const lwd = last_working_date ? fmtDate(last_working_date) : fmtDate(new Date());
            title = 'Experience Certificate';
            body = [
                `This is to certify that ${fullName} (Employee ID: ${emp.employee_id}) was employed with ${company.name} as ${emp.designation_name || 'an employee'}${emp.department_name ? ` in the ${emp.department_name} department` : ''}.`,
                `${emp.first_name} served the organization from ${fmtDate(emp.joining_date)} to ${lwd}. During this tenure, we found them to be sincere, dedicated and professional in their conduct and responsibilities.`,
                `We wish ${emp.first_name} all the best in their future endeavours.`
            ];
        } else {
            title = 'Employment Certificate';
            body = [
                `This is to certify that ${fullName} (Employee ID: ${emp.employee_id}) is currently employed with ${company.name} as ${emp.designation_name || 'an employee'}${emp.department_name ? ` in the ${emp.department_name} department` : ''}, since ${fmtDate(emp.joining_date)}.`,
                `${emp.first_name} is a full-time employee of the organization and continues to serve in the mentioned capacity.`,
                `This certificate is issued on request for official purposes.`
            ];
        }

        const pdfBuffer = await renderLetterPdf(company, emp, {
            title,
            refNo,
            body,
            signatoryName: signatory_name || null,
            signatoryRole: signatory_role || null
        });

        logAudit({
            actorId: req.user.id,
            action: 'letter.generate',
            entityType: 'employee',
            entityId: emp.id,
            details: { letter_type, ref_no: refNo },
            ip: req.ip
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${letter_type}_letter_${emp.employee_id}.pdf`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('Letter generation error:', error);
        res.status(500).json({ success: false, message: 'Letter generation failed' });
    }
});

module.exports = router;
