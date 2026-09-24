const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, getPool } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { validateEmployee, collectFieldErrors } = require('../middleware/validation');
const { deleteFile, deleteFileByUrl } = require('../services/storage');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const { startOnboarding } = require('../services/onboarding');
const { sendWelcomeEmail } = require('../services/email');
const { buildReportWorkbook, sendWorkbook } = require('../utils/excel');

const MAIN_ADMIN_ID = 1;

// Convert an incoming numeric value to a number, or null when the value is
// missing/blank. Returning null lets COALESCE keep the existing DB value so
// empty form fields never overwrite stored salary/allowance data with 0.
function cleanNum(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (s === '' || s.toLowerCase() === 'null' || s.toLowerCase() === 'nan') return null;
    const n = Number(s);
    return isNaN(n) ? null : n;
}

async function activeAdminCount() {
    const r = await query(`SELECT COUNT(*) AS count FROM employees WHERE role = 'admin' AND status = 'active'`);
    return parseInt(r.rows[0].count, 10);
}

async function lastActiveAdminGuard(targetId) {
    const r = await query('SELECT role, status FROM employees WHERE id = $1', [targetId]);
    const target = r.rows[0];
    if (target && target.role === 'admin' && target.status === 'active' && await activeAdminCount() <= 1) {
        return 'Cannot remove the last active admin. You would lose all admin access.';
    }
    return null;
}

// Only the MAIN_ADMIN_ID account may create/promote/demote/pause/delete admin
// accounts or reset an admin's password.
async function adminTargetGuard(targetId, requesterId) {
    const r = await query('SELECT role FROM employees WHERE id = $1', [targetId]);
    if (r.rows[0] && r.rows[0].role === 'admin' && Number(requesterId) !== MAIN_ADMIN_ID) {
        return 'Only the main Admin can manage admin accounts.';
    }
    return null;
}

// @route   GET /api/employees
// @desc    Get all employees
// @access  Private (Admin/HR)
router.get('/', verifyToken, isAdmin, async (req, res) => {
    try {
        const { search, department, designation, status, page = 1, limit = 10 } = req.query;
        let sqlQuery = `
            SELECT e.*, d.name as department_name, des.name as designation_name, des.level as designation_level,
            rm.first_name || ' ' || rm.last_name as reporting_manager_name, rm.employee_id as reporting_manager_employee_id,
            srm.first_name || ' ' || srm.last_name as secondary_reporting_manager_name, srm.employee_id as secondary_reporting_manager_employee_id
            FROM employees e 
            LEFT JOIN departments d ON e.department_id = d.id 
            LEFT JOIN designations des ON e.designation_id = des.id 
            LEFT JOIN employees rm ON e.reporting_manager_id = rm.id
            LEFT JOIN employees srm ON e.secondary_reporting_manager_id = srm.id
            WHERE 1=1 AND e.id != ${MAIN_ADMIN_ID}
        `;
        const params = [];
        let paramIndex = 1;
        
        if (search) {
            sqlQuery += ` AND (LOWER(e.first_name) LIKE LOWER($${paramIndex}) OR LOWER(e.last_name) LIKE LOWER($${paramIndex}) OR LOWER(e.email) LIKE LOWER($${paramIndex}) OR LOWER(e.employee_id) LIKE LOWER($${paramIndex}))`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        if (department) {
            sqlQuery += ` AND e.department_id = $${paramIndex}`;
            params.push(department);
            paramIndex++;
        }

        if (designation) {
            if (designation === 'none') {
                sqlQuery += ` AND e.designation_id IS NULL`;
            } else {
                sqlQuery += ` AND e.designation_id = $${paramIndex}`;
                params.push(designation);
                paramIndex++;
            }
        }
        
        if (status) {
            sqlQuery += ` AND e.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }
        
        // Count total
        const countResult = await runWithSchemaRepair(() => query(
            sqlQuery.replace(/SELECT[\s\S]*?FROM employees/, 'SELECT COUNT(*) as count FROM employees'),
            params
        ));
        const total = parseInt(countResult.rows[0].count);
        
        // Pagination
        const offset = (page - 1) * limit;
        sqlQuery += ` ORDER BY e.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);
        
        const result = await runWithSchemaRepair(() => query(sqlQuery, params));
        
        // Remove password_hash from results
        const employees = result.rows.map(emp => {
            const { password_hash, ...employee } = emp;
            return employee;
        });
        
        res.json({
            success: true,
            employees,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
            }
        });
        
    } catch (error) {
        console.error('Get employees error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/employees/directory
// @desc    Staff directory. Admins see the whole company; everyone else sees
//          only their own team - a manager/team_lead sees their direct reports,
//          and a regular employee sees their teammates plus their reporting
//          manager (the TL). The caller's own card is always hidden and the
//          contact shown is the personal email/phone, never work details.
// @access  Private (any authenticated employee)
const DIRECTORY_COLUMNS = `SELECT e.id, e.employee_id, e.first_name, e.last_name,
        e.personal_email, e.phone,
        d.name AS department_name, g.name AS designation_name,
        rm.first_name || ' ' || rm.last_name AS reporting_manager
FROM employees e
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN designations g ON g.id = e.designation_id
LEFT JOIN employees rm ON rm.id = e.reporting_manager_id`;

router.get('/directory', verifyToken, async (req, res) => {
    try {
        const meRes = await query(
            'SELECT role, reporting_manager_id FROM employees WHERE id = $1',
            [req.user.id]
        );
        const me = meRes.rows[0];

        let rows;
        let scope;

        if (!me) {
            rows = [];
            scope = 'team';
        } else if (me.role === 'admin' || me.role === 'hr' || me.role === 'manager') {
            // Admin/HR/Manager see ALL active employees (excluding self and admin)
            const result = await query(
                `${DIRECTORY_COLUMNS}
                WHERE e.status = 'active' AND e.id <> $1 AND e.role != 'admin'
                ORDER BY e.first_name, e.last_name`,
                [req.user.id]
            );
            rows = result.rows;
            scope = 'company';
        } else if (me.role === 'team_lead') {
            // Direct reports (own card hidden).
            const result = await query(
                `${DIRECTORY_COLUMNS}
                WHERE e.status = 'active' AND e.reporting_manager_id = $1 AND e.id <> $1
                ORDER BY e.first_name, e.last_name`,
                [req.user.id]
            );
            rows = result.rows;
            scope = 'team';
        } else {
            // Team member: show teammates (same manager) + the manager, self hidden.
            // Without a reporting manager fall back to the company view.
            const anchorId = me.reporting_manager_id || null;
            if (!anchorId) {
                const result = await query(
                    `${DIRECTORY_COLUMNS}
                    WHERE e.status = 'active' AND e.id <> $1 AND e.role != 'admin'
                    ORDER BY e.first_name, e.last_name`,
                    [req.user.id]
                );
                rows = result.rows;
                scope = 'company';
            } else {
                const result = await query(
                    `${DIRECTORY_COLUMNS}
                    WHERE e.status = 'active' AND (e.reporting_manager_id = $1 OR e.id = $1) AND e.id <> $2
                    ORDER BY e.first_name, e.last_name`,
                    [anchorId, req.user.id]
                );
                rows = result.rows;
                scope = 'team';
            }
        }

        res.json({ success: true, scope, directory: rows });
    } catch (error) {
        console.error('Directory error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/employees/birthdays
// @desc    Today's and upcoming birthdays (next 30 days), company-wide
// @access  Private (any authenticated employee)
router.get('/birthdays', verifyToken, async (req, res) => {
    try {
        const result = await query(
            `SELECT id, employee_id, first_name, last_name, date_of_birth
            FROM employees
            WHERE status = 'active' AND date_of_birth IS NOT NULL`
        );

        const { istDateString } = require('../utils/date');
        const today = new Date(istDateString() + 'T00:00:00Z');
        const todayKey = (d) => String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
        const todayMmDd = todayKey(today);

        const list = [];
        for (const e of result.rows) {
            // Normalise the birth year onto the current/next calendar year so
            // Feb-29 people still get a slot (moved to Mar-01 on non-leap years).
            let next = new Date(Date.UTC(today.getUTCFullYear(), e.date_of_birth.getUTCMonth(), e.date_of_birth.getUTCDate()));
            if (next < today) {
                next = new Date(Date.UTC(today.getUTCFullYear() + 1, e.date_of_birth.getUTCMonth(), e.date_of_birth.getUTCDate()));
            }
            const daysAway = Math.round((next - today) / 86400000);
            if (daysAway > 30) continue;
            list.push({
                id: e.id,
                employee_id: e.employee_id,
                first_name: e.first_name,
                last_name: e.last_name,
                birthday: `${String(e.date_of_birth.getUTCDate()).padStart(2, '0')} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][e.date_of_birth.getUTCMonth()]}`,
                days_away: daysAway,
                is_today: todayKey(next) === todayMmDd
            });
        }

        list.sort((a, b) => a.days_away - b.days_away);
        res.json({ success: true, birthdays: list });
    } catch (error) {
        console.error('Birthdays error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/employees/export
// @desc    Branded Excel export of the full employee master (incl. statutory,
//          bank and salary component columns - admin-only download).
// @access  Private (Admin)
// NOTE: registered before GET /:id so "export" is never captured as an id.
router.get('/export', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await query(
            `SELECT e.*, d.name AS department_name, des.name AS designation_name,
                rm.first_name || ' ' || rm.last_name AS reporting_manager_name
            FROM employees e
            LEFT JOIN departments d ON d.id = e.department_id
            LEFT JOIN designations des ON des.id = e.designation_id
            LEFT JOIN employees rm ON rm.id = e.reporting_manager_id
            WHERE e.id <> $1
            ORDER BY e.employee_id`,
            [MAIN_ADMIN_ID]
        );

        const M = (header, key, opts = {}) => ({ header, key, type: 'money', ...opts });
        const rows = result.rows.map(e => ({
            emp_code: e.employee_id,
            first_name: e.first_name,
            last_name: e.last_name,
            email: e.email,
            personal_email: e.personal_email,
            phone: e.phone,
            department: e.department_name,
            designation: e.designation_name,
            role: e.role,
            reporting_manager: e.reporting_manager_name,
            joining_date: e.joining_date,
            status: e.status,
            status_reason: e.status_reason,
            last_working_day: e.last_working_day,
            gender: e.gender,
            date_of_birth: e.date_of_birth,
            blood_group: e.blood_group,
            marital_status: e.marital_status,
            qualification: e.qualification,
            specialization: e.specialization,
            languages_spoken: e.languages_spoken,
            emergency_contact_name: e.emergency_contact_name,
            emergency_contact: e.emergency_contact,
            address: e.address,
            permanent_address: e.permanent_address,
            salary: e.salary,
            basic_salary: e.basic_salary,
            hra: e.hra,
            conveyance: e.conveyance,
            medical: e.medical,
            special_allowance: e.special_allowance,
            other_allowance: e.other_allowance,
            pf: e.pf,
            esi: e.esi,
            professional_tax: e.professional_tax,
            income_tax: e.income_tax,
            loan_deduction: e.loan_deduction,
            advance_salary: e.advance_salary,
            other_deduction: e.other_deduction,
            incentive: e.incentive,
            bonus: e.bonus,
            extra_work: e.extra_work,
            employer_pf: e.employer_pf,
            employer_esi: e.employer_esi,
            employer_contribution: e.employer_contribution,
            uan_number: e.uan_number,
            pf_number: e.pf_number,
            esi_number: e.esi_number,
            pan_number: e.pan_number,
            aadhaar_number: e.aadhaar_number,
            passport_number: e.passport_number,
            bank_name: e.bank_name,
            bank_branch: e.bank_branch,
            bank_account: e.bank_account,
            bank_ifsc: e.bank_ifsc
        }));

        const columns = [
            { header: 'Emp ID', key: 'emp_code', width: 12 },
            { header: 'First Name', key: 'first_name' },
            { header: 'Last Name', key: 'last_name' },
            { header: 'Official Email', key: 'email', width: 26 },
            { header: 'Personal Email', key: 'personal_email', width: 26 },
            { header: 'Phone', key: 'phone', width: 14 },
            { header: 'Department', key: 'department' },
            { header: 'Designation', key: 'designation' },
            { header: 'Role', key: 'role', type: 'status' },
            { header: 'Reporting Manager', key: 'reporting_manager', width: 20 },
            { header: 'Joining Date', key: 'joining_date', type: 'date', width: 13 },
            { header: 'Status', key: 'status', type: 'status' },
            { header: 'Status Reason', key: 'status_reason', width: 24 },
            { header: 'Last Working Day', key: 'last_working_day', type: 'date', width: 14 },
            { header: 'Gender', key: 'gender' },
            { header: 'Date of Birth', key: 'date_of_birth', type: 'date', width: 13 },
            { header: 'Blood Group', key: 'blood_group', width: 11 },
            { header: 'Marital Status', key: 'marital_status', width: 13 },
            { header: 'Qualification', key: 'qualification' },
            { header: 'Specialization', key: 'specialization' },
            { header: 'Languages Spoken', key: 'languages_spoken', width: 20 },
            { header: 'Emergency Contact Name', key: 'emergency_contact_name', width: 20 },
            { header: 'Emergency Contact', key: 'emergency_contact', width: 16 },
            { header: 'Current Address', key: 'address', width: 30 },
            { header: 'Permanent Address', key: 'permanent_address', width: 30 },
            M('Total Compensation', 'salary'),
            M('Basic Salary', 'basic_salary'),
            M('HRA', 'hra'),
            M('Conveyance', 'conveyance'),
            M('Medical Allowance', 'medical'),
            M('Special Allowance', 'special_allowance'),
            M('Other Allowance', 'other_allowance'),
            M('Employee PF', 'pf'),
            M('Employee ESI', 'esi'),
            M('Professional Tax', 'professional_tax'),
            M('Income Tax', 'income_tax'),
            M('Loan Deduction', 'loan_deduction'),
            M('Advance Salary', 'advance_salary'),
            M('Other Deduction', 'other_deduction'),
            M('Incentive', 'incentive'),
            M('Bonus', 'bonus'),
            M('Extra Work', 'extra_work'),
            M('Employer PF', 'employer_pf'),
            M('Employer ESI', 'employer_esi'),
            M('Employer Contribution', 'employer_contribution'),
            { header: 'UAN Number', key: 'uan_number', width: 14 },
            { header: 'PF Number', key: 'pf_number', width: 14 },
            { header: 'ESI Number', key: 'esi_number', width: 14 },
            { header: 'PAN Number', key: 'pan_number', width: 14 },
            { header: 'Aadhaar Number', key: 'aadhaar_number', width: 15 },
            { header: 'Passport Number', key: 'passport_number', width: 15 },
            { header: 'Bank Name', key: 'bank_name', width: 18 },
            { header: 'Bank Branch', key: 'bank_branch', width: 18 },
            { header: 'Bank Account No', key: 'bank_account', width: 18 },
            { header: 'IFSC Code', key: 'bank_ifsc', width: 14 }
        ];

        const wb = await buildReportWorkbook({
            reportName: 'Employee Master Report',
            subtitleExtra: 'All statuses • Confidential - admin only',
            columns,
            rows,
            footerNote: req.user.name || 'Admin'
        });

        logAudit({
            actorId: req.user.id,
            action: 'data.export',
            entityType: 'report',
            entityId: null,
            details: { report: 'employees_master', records: rows.length },
            ip: req.ip
        });

        await sendWorkbook(res, wb, 'Employees_' + new Date().toISOString().split('T')[0] + '.xlsx');
    } catch (error) {
        console.error('Employee export error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/employees/:id
// @desc    Get single employee
// @access  Private (Admin/HR full access; others self or reporting-chain members only, PII stripped)
router.get('/:id', verifyToken, async (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        if (!Number.isInteger(targetId)) {
            return res.status(400).json({ success: false, message: 'Invalid employee id' });
        }

        const isAdminUser = req.user.role === 'admin';
        if (!isAdminUser) {
            // Grant access only if the target employee sits inside the requester's
            // reporting subtree (requester is their manager, or higher up the chain).
            const canView = await query(
                `WITH RECURSIVE chain AS (
                    SELECT id FROM employees WHERE id = $1
                    UNION
                    SELECT e.id FROM employees e JOIN chain c ON e.reporting_manager_id = c.id
                 )
                 SELECT 1 AS found FROM chain WHERE id = $2 LIMIT 1`,
                [req.user.id, targetId]
            );
            if (canView.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
        }

        const result = await runWithSchemaRepair(() => query(
            `SELECT e.*, d.name as department_name, des.name as designation_name, des.level as designation_level,
            rm.first_name || ' ' || rm.last_name as reporting_manager_name, rm.employee_id as reporting_manager_employee_id,
            srm.first_name || ' ' || srm.last_name as secondary_reporting_manager_name, srm.employee_id as secondary_reporting_manager_employee_id
            FROM employees e 
            LEFT JOIN departments d ON e.department_id = d.id 
            LEFT JOIN designations des ON e.designation_id = des.id 
            LEFT JOIN employees rm ON e.reporting_manager_id = rm.id
            LEFT JOIN employees srm ON e.secondary_reporting_manager_id = srm.id
            WHERE e.id = $1`,
            [targetId]
        ));
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        
        const employee = result.rows[0];
        delete employee.password_hash;

        // Strip sensitive PII for non-admin viewers (self/team view still gets base profile)
        if (!isAdminUser) {
            const sensitiveFields = ['salary', 'pan_number', 'aadhaar_number', 'passport_number',
                'bank_name', 'bank_branch', 'bank_account', 'bank_ifsc',
                'basic_salary', 'hra', 'conveyance', 'medical', 'special_allowance', 'other_allowance',
                'pf', 'esi', 'professional_tax', 'income_tax', 'loan_deduction', 'advance_salary', 'other_deduction',
                'incentive', 'bonus', 'extra_work', 'employer_pf', 'employer_esi', 'employer_contribution'];
            sensitiveFields.forEach(f => delete employee[f]);
        }
        
        res.json({ success: true, employee });
        
    } catch (error) {
        console.error('Get employee error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/employees
// @desc    Create new employee
// @access  Private (Admin/HR)
// Shared single-employee creation used by POST / and the CSV bulk import.
// Returns { ok, employee, tempPassword, errors } instead of throwing so the
// bulk importer can report per-row failures.
async function createEmployeeRecord(body, req) {
    const fieldErrors = collectFieldErrors(body);
    if (fieldErrors.length > 0) {
        return { ok: false, errors: fieldErrors };
    }

    const {
        employee_id, first_name, last_name, email, phone,
        password, department_id, designation_id, joining_date,
        salary, role, address, date_of_birth, gender,
        permanent_address, languages_spoken, marital_status, personal_email,
        qualification, specialization, pan_number, aadhaar_number, passport_number,
        uan_number, pf_number, esi_number,
        bank_name, bank_branch, bank_account, bank_ifsc, reporting_manager_id,
        basic_salary, hra, conveyance, medical, special_allowance, other_allowance,
        pf, esi, professional_tax, income_tax, loan_deduction, advance_salary, other_deduction,
        incentive, bonus, extra_work, employer_pf, employer_esi, employer_contribution
    } = body;

    // Only the main Admin can create admin accounts.
    if (role === 'admin' && Number(req.user.id) !== MAIN_ADMIN_ID) {
        return { ok: false, errors: ['Only the main Admin can create admin accounts.'] };
    }

    // Check if email exists
    const emailCheck = await query('SELECT id FROM employees WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) {
        return { ok: false, errors: ['Email already exists'] };
    }

    // Check if employee_id exists (uniqueness pre-check so users get a clear message)
    const empIdCheck = await query('SELECT id FROM employees WHERE employee_id = $1', [employee_id]);
    if (empIdCheck.rows.length > 0) {
        return { ok: false, errors: ['Employee ID already exists'] };
    }

    // Validate numeric fields early so a bad value gives a friendly message
    // instead of a Postgres cast error.
    const numFields = {
        salary: 'Salary', basic_salary: 'Basic Salary', hra: 'HRA', conveyance: 'Conveyance',
        medical: 'Medical Allowance', special_allowance: 'Special Allowance', other_allowance: 'Medical Allowance',
        pf: 'Employee PF', esi: 'Employee ESI', professional_tax: 'Professional Tax', income_tax: 'Income Tax',
        loan_deduction: 'Loan Deduction', advance_salary: 'Advance Salary', other_deduction: 'Other Deduction',
        incentive: 'Incentive', bonus: 'Attendance Incentive (Bonus)', extra_work: 'Extra Work',
        employer_pf: 'Employer PF', employer_esi: 'Employer ESI', employer_contribution: 'Employer Contribution'
    };
    const numErrors = [];
    for (const [key, label] of Object.entries(numFields)) {
        const v = body[key];
        if (v !== undefined && v !== null && String(v).trim() !== '' && isNaN(Number(String(v).trim()))) {
            numErrors.push(label + ' must be a valid number');
        }
    }
    if (numErrors.length > 0) {
        return { ok: false, errors: numErrors };
    }

    // Generate random temp password if not provided
    const tempPassword = password || crypto.randomBytes(6).toString('base64url');
    const salt = await bcrypt.genSalt(12);
    const password_hash = await bcrypt.hash(tempPassword, salt);

    const result = await runWithSchemaRepair(() => query(
        `INSERT INTO employees 
        (employee_id, first_name, last_name, email, phone, password_hash, 
         department_id, designation_id, joining_date, salary, role, address, 
         date_of_birth, gender, must_change_password,
         permanent_address, languages_spoken, marital_status, personal_email,
         qualification, specialization, pan_number, aadhaar_number, passport_number,
         uan_number, pf_number, esi_number,
         bank_name, bank_branch, bank_account, bank_ifsc, reporting_manager_id,
         basic_salary, hra, conveyance, medical, special_allowance, other_allowance,
         pf, esi, professional_tax, income_tax, loan_deduction, advance_salary, other_deduction,
         incentive, bonus, extra_work, employer_pf, employer_esi, employer_contribution,
         secondary_reporting_manager_id) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1,
         $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
         $28, $29, $30, $31,
         $32, $33, $34, $35, $36, $37,
         $38, $39, $40, $41, $42, $43, $44,
         $45, $46, $47, $48, $49, $50, $51) 
        RETURNING id, employee_id, first_name, last_name, email, personal_email, role, status`,
        [
            employee_id, first_name, last_name, email, phone, password_hash,
            cleanNum(department_id) ?? null, cleanNum(designation_id) ?? null, joining_date,
            cleanNum(salary), role || 'employee', address || null,
            date_of_birth || null, gender || null,
            permanent_address || null, languages_spoken || null, marital_status || null, personal_email || null,
            qualification || null, specialization || null, pan_number || null, aadhaar_number || null, passport_number || null,
            uan_number || null, pf_number || null, esi_number || null,
            bank_name || null, bank_branch || null, bank_account || null, bank_ifsc || null,
            cleanNum(reporting_manager_id) ?? null,
            cleanNum(basic_salary) ?? 0, cleanNum(hra) ?? 0, cleanNum(conveyance) ?? 0, cleanNum(medical) ?? 0,
            cleanNum(special_allowance) ?? 0, cleanNum(other_allowance) ?? 0,
            cleanNum(pf) ?? 0, cleanNum(esi) ?? 0, cleanNum(professional_tax) ?? 0, cleanNum(income_tax) ?? 0,
            cleanNum(loan_deduction) ?? 0, cleanNum(advance_salary) ?? 0, cleanNum(other_deduction) ?? 0,
            cleanNum(incentive) ?? 0, cleanNum(bonus) ?? 0, cleanNum(extra_work) ?? 0,
            cleanNum(employer_pf) ?? 0, cleanNum(employer_esi) ?? 0, cleanNum(employer_contribution) ?? 0,
            // New employees are auto-assigned to the main admin in addition to
            // their team lead so the admin always sees/approves their requests.
            cleanNum(reporting_manager_id) ? MAIN_ADMIN_ID : null
        ]
    ));

    return { ok: true, employee: result.rows[0], tempPassword };
}

router.post('/', verifyToken, isAdmin, validateEmployee, async (req, res) => {
    try {
        const created = await createEmployeeRecord(req.body, req);
        if (!created.ok) {
            return res.status(400).json({ success: false, errors: created.errors });
        }

        logAudit({
            actorId: req.user.id,
            action: 'employee.create',
            entityType: 'employee',
            entityId: created.employee.id,
            details: { employee_code: created.employee.employee_id, email: created.employee.email },
            ip: req.ip
        });

        // Auto-start the onboarding journey (copies the active checklist
        // templates into per-employee tasks + welcome push). Best-effort:
        // a failure here must never fail the employee creation itself.
        let onboarding_started = false;
        try {
            const ob = await startOnboarding(created.employee.id, req.user.id);
            onboarding_started = !!(ob && ob.ok && !ob.already);
        } catch (obError) {
            console.error('Onboarding auto-start error:', obError.message);
        }

        // Welcome mail with login credentials. Goes to the personal address
        // when the admin captured one, else to the office address. Opt-out via
        // send_welcome_email:false. Best-effort as well - the response reports
        // email_sent so the admin knows whether the joiner was notified.
        let email_sent = false;
        if (req.body.send_welcome_email !== false) {
            try {
                const mailResult = await sendWelcomeEmail(
                    created.employee.personal_email || created.employee.email,
                    {
                        name: `${created.employee.first_name} ${created.employee.last_name}`,
                        empId: created.employee.employee_id,
                        tempPassword: created.tempPassword
                    }
                );
                email_sent = !!(mailResult && mailResult.success);
            } catch (mailError) {
                console.error('Welcome email error:', mailError.message);
            }
        }

        res.status(201).json({
            success: true,
            employee: created.employee,
            temp_password: created.tempPassword,
            email_sent,
            onboarding_started
        });

    } catch (error) {
        console.error('Create employee error:', error);
        const mapped = pgErrorResponse(error);
        const body = { success: false, message: mapped.message };
        if (req.user && req.user.role === 'admin') {
            body.detail = error && error.message;
        }
        res.status(mapped.status).json(body);
    }
});

// @route   POST /api/employees/import
// @desc    Bulk-create employees from parsed CSV rows (per-row error report)
// @access  Private (Admin/HR)
router.post('/import', verifyToken, isAdmin, async (req, res) => {
    try {
        const items = req.body.items;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: 'No rows to import' });
        }
        if (items.length > 500) {
            return res.status(400).json({ success: false, message: 'Maximum 500 rows per import. Split the file.' });
        }

        const results = [];
        let created = 0;

        for (let i = 0; i < items.length; i++) {
            const rowNum = i + 1;
            try {
                const r = await createEmployeeRecord(items[i] || {}, req);
                if (r.ok) {
                    created++;
                    logAudit({
                        actorId: req.user.id,
                        action: 'employee.import_create',
                        entityType: 'employee',
                        entityId: r.employee.id,
                        details: { employee_code: r.employee.employee_id, row: rowNum },
                        ip: req.ip
                    });
                    results.push({ row: rowNum, ok: true, employee_id: r.employee.employee_id, temp_password: r.tempPassword });
                } else {
                    results.push({ row: rowNum, ok: false, error: (r.errors || ['Invalid row']).join('; ') });
                }
            } catch (rowError) {
                const mapped = pgErrorResponse(rowError);
                results.push({ row: rowNum, ok: false, error: mapped.message });
            }
        }

        logAudit({
            actorId: req.user.id,
            action: 'employee.import_bulk',
            entityType: 'employee',
            entityId: null,
            details: { created, failed: results.length - created, total: items.length },
            ip: req.ip
        });

        res.json({ success: true, created, failed: results.length - created, results });
    } catch (error) {
        console.error('Import employees error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   PUT /api/employees/:id
// @desc    Update employee
// @access  Private (Admin/HR)
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const fieldErrors = collectFieldErrors(req.body);
        if (fieldErrors.length > 0) {
            return res.status(400).json({ success: false, errors: fieldErrors });
        }
        const { 
            first_name, last_name, email, phone, department_id, 
            designation_id, salary, role, status, address,
            joining_date, gender, date_of_birth, blood_group,
            emergency_contact, emergency_contact_name,
            permanent_address, languages_spoken, marital_status, personal_email,
            qualification, specialization, pan_number, aadhaar_number, passport_number,
            uan_number, pf_number, esi_number,
            bank_name, bank_branch, bank_account, bank_ifsc, reporting_manager_id,
            basic_salary, hra, conveyance, medical, special_allowance, other_allowance,
            pf, esi, professional_tax, income_tax, loan_deduction, advance_salary, other_deduction,
            incentive, bonus, extra_work, employer_pf, employer_esi, employer_contribution
        } = req.body;

        if (reporting_manager_id && parseInt(reporting_manager_id) === parseInt(req.params.id)) {
            return res.status(400).json({ success: false, message: 'An employee cannot be their own reporting manager' });
        }

        // Email uniqueness check excluding this employee's own record
        if (email) {
            const emailDup = await query('SELECT id FROM employees WHERE email = $1 AND id != $2', [email, req.params.id]);
            if (emailDup.rows.length > 0) {
                return res.status(400).json({ success: false, message: 'Email already exists' });
            }
        }

        // Only the main Admin can manage admin accounts (promote to admin, or change an admin's role/status).
        if (Number(req.user.id) !== MAIN_ADMIN_ID) {
            const cur = await query('SELECT role FROM employees WHERE id = $1', [req.params.id]);
            const curIsAdmin = cur.rows[0] && cur.rows[0].role === 'admin';
            if (role === 'admin' || (curIsAdmin && (role !== undefined || status !== undefined))) {
                return res.status(403).json({ success: false, message: 'Only the main Admin can manage admin accounts.' });
            }
        }

        // Last-active-admin guard: don't allow demoting/deactivating the final active admin.
        if ((role && role !== 'admin') || (status && status !== 'active')) {
            const guardError = await lastActiveAdminGuard(req.params.id);
            if (guardError) {
                return res.status(400).json({ success: false, message: guardError });
            }
        }

        // Cycle prevention: walk up the reporting chain from the candidate RM.
        // If it ever reaches the employee being edited, a cycle would be created.
        if (reporting_manager_id) {
            let currentId = parseInt(reporting_manager_id);
            const seen = new Set();
            let isCycle = false;
            while (currentId && !seen.has(currentId)) {
                if (currentId === parseInt(req.params.id)) {
                    isCycle = true;
                    break;
                }
                seen.add(currentId);
                const up = await query('SELECT reporting_manager_id FROM employees WHERE id = $1', [currentId]);
                currentId = up.rows[0] ? up.rows[0].reporting_manager_id : null;
            }
            if (isCycle) {
                return res.status(400).json({ success: false, message: 'Invalid reporting manager. This would create a reporting cycle.' });
            }
        }
        
        const result = await runWithSchemaRepair(() => query(
            `UPDATE employees SET 
            first_name = COALESCE($1, first_name),
            last_name = COALESCE($2, last_name),
            email = COALESCE($3, email),
            phone = COALESCE($4, phone),
            department_id = COALESCE($5, department_id),
            designation_id = COALESCE($6, designation_id),
            salary = COALESCE($7::numeric, salary),
            role = COALESCE($8, role),
            status = COALESCE($9, status),
            address = COALESCE($10, address),
            joining_date = COALESCE($11, joining_date),
            gender = COALESCE($12, gender),
            date_of_birth = COALESCE($13, date_of_birth),
            blood_group = COALESCE($14, blood_group),
            emergency_contact = COALESCE($15, emergency_contact),
            emergency_contact_name = COALESCE($16, emergency_contact_name),
            permanent_address = COALESCE($17, permanent_address),
            languages_spoken = COALESCE($18, languages_spoken),
            marital_status = COALESCE($19, marital_status),
            personal_email = COALESCE($20, personal_email),
            qualification = COALESCE($21, qualification),
            specialization = COALESCE($22, specialization),
            pan_number = COALESCE($23, pan_number),
            aadhaar_number = COALESCE($24, aadhaar_number),
            passport_number = COALESCE($25, passport_number),
            uan_number = COALESCE($26, uan_number),
            pf_number = COALESCE($27, pf_number),
            esi_number = COALESCE($28, esi_number),
            bank_name = COALESCE($29, bank_name),
            bank_branch = COALESCE($30, bank_branch),
            bank_account = COALESCE($31, bank_account),
            bank_ifsc = COALESCE($32, bank_ifsc),
            basic_salary = COALESCE($33::numeric, basic_salary),
            hra = COALESCE($34::numeric, hra),
            conveyance = COALESCE($35::numeric, conveyance),
            medical = COALESCE($36::numeric, medical),
            special_allowance = COALESCE($37::numeric, special_allowance),
            other_allowance = COALESCE($38::numeric, other_allowance),
            pf = COALESCE($39::numeric, pf),
            esi = COALESCE($40::numeric, esi),
            professional_tax = COALESCE($41::numeric, professional_tax),
            income_tax = COALESCE($42::numeric, income_tax),
            loan_deduction = COALESCE($43::numeric, loan_deduction),
            advance_salary = COALESCE($44::numeric, advance_salary),
            other_deduction = COALESCE($45::numeric, other_deduction),
            incentive = COALESCE($46::numeric, incentive),
            bonus = COALESCE($47::numeric, bonus),
            extra_work = COALESCE($48::numeric, extra_work),
            employer_pf = COALESCE($49::numeric, employer_pf),
            employer_esi = COALESCE($50::numeric, employer_esi),
            employer_contribution = COALESCE($51::numeric, employer_contribution),
            reporting_manager_id = CASE WHEN $52::text = '' THEN NULL ELSE COALESCE($52::int, reporting_manager_id) END,
            updated_at = NOW()
            WHERE id = $53
            RETURNING id, employee_id, first_name, last_name, email, role`,
            [first_name, last_name, email, phone, cleanNum(department_id), cleanNum(designation_id), 
             cleanNum(salary), role, status, address, joining_date, gender, date_of_birth,
             blood_group, emergency_contact, emergency_contact_name,
             permanent_address, languages_spoken, marital_status, personal_email,
             qualification, specialization, pan_number, aadhaar_number, passport_number,
             uan_number, pf_number, esi_number,
             bank_name, bank_branch, bank_account, bank_ifsc,
             cleanNum(basic_salary), cleanNum(hra), cleanNum(conveyance), cleanNum(medical), cleanNum(special_allowance), cleanNum(other_allowance),
             cleanNum(pf), cleanNum(esi), cleanNum(professional_tax), cleanNum(income_tax), cleanNum(loan_deduction), cleanNum(advance_salary), cleanNum(other_deduction),
             cleanNum(incentive), cleanNum(bonus), cleanNum(extra_work), cleanNum(employer_pf), cleanNum(employer_esi), cleanNum(employer_contribution),
             reporting_manager_id, req.params.id]
        ));
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }

        logAudit({
            actorId: req.user.id,
            action: 'employee.update',
            entityType: 'employee',
            entityId: result.rows[0].id,
            details: { fields: Object.keys(req.body || {}) },
            ip: req.ip
        });

        res.json({ success: true, employee: result.rows[0] });
        
    } catch (error) {
        console.error('Update employee error:', error);
        const mapped = pgErrorResponse(error);
        const body = { success: false, message: mapped.message };
        if (req.user && req.user.role === 'admin') {
            body.detail = error && error.message;
        }
        res.status(mapped.status).json(body);
    }
});

// @route   POST /api/employees/:id/reset-password
// @desc    Admin resets an employee password and forces change on next login
// @access  Private (Admin/HR)
router.post('/:id/reset-password', verifyToken, isAdmin, async (req, res) => {
    try {
        const adminGuardError = await adminTargetGuard(req.params.id, req.user.id);
        if (adminGuardError) {
            return res.status(403).json({ success: false, message: adminGuardError });
        }

        const tempPassword = req.body.password || crypto.randomBytes(6).toString('base64url') + 'A1';
        const salt = await bcrypt.genSalt(12);
        const password_hash = await bcrypt.hash(tempPassword, salt);

        const result = await query(
            `UPDATE employees SET password_hash = $1, must_change_password = 1,
                token_version = COALESCE(token_version, 0) + 1, updated_at = NOW()
            WHERE id = $2 RETURNING id, first_name, last_name`,
            [password_hash, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }

        logAudit({
            actorId: req.user.id,
            action: 'employee.reset_password',
            entityType: 'employee',
            entityId: result.rows[0].id,
            details: { target: (result.rows[0].first_name || '') + ' ' + (result.rows[0].last_name || '') },
            ip: req.ip
        });

        res.json({ success: true, message: 'Password reset', temp_password: tempPassword, employee: result.rows[0] });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/employees/:id/pause
// @desc    Pause employee (blocks login, keeps all data)
// @access  Private (Admin)
router.post('/:id/pause', verifyToken, isAdmin, async (req, res) => {
    try {
        if (parseInt(req.params.id) === parseInt(req.user.id)) {
            return res.status(400).json({ success: false, message: 'You cannot pause your own account' });
        }
        const adminGuardError = await adminTargetGuard(req.params.id, req.user.id);
        if (adminGuardError) {
            return res.status(403).json({ success: false, message: adminGuardError });
        }
        const guardError = await lastActiveAdminGuard(req.params.id);
        if (guardError) {
            return res.status(400).json({ success: false, message: guardError });
        }
        const result = await query(
            `UPDATE employees SET status = 'paused', updated_at = NOW() 
            WHERE id = $1 RETURNING id`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        logAudit({ actorId: req.user.id, action: 'employee.pause', entityType: 'employee', entityId: req.params.id, ip: req.ip });
        res.json({ success: true, message: 'Employee paused successfully' });
    } catch (error) {
        console.error('Pause employee error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/employees/:id/resume
// @desc    Resume a paused/on_hold/inactive employee back to active (legacy, kept for compatibility)
// @access  Private (Admin)
router.post('/:id/resume', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await runWithSchemaRepair(() => query(
            `UPDATE employees SET status = 'active', status_reason = COALESCE($2, status_reason),
                status_changed_at = NOW(), status_changed_by = $3, updated_at = NOW()
            WHERE id = $1 AND status IN ('paused', 'on_hold', 'inactive') RETURNING id, status`,
            [req.params.id, req.body && req.body.reason ? String(req.body.reason).trim() : null, req.user.id]
        ));
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Employee is not paused / on hold' });
        }
        logAudit({ actorId: req.user.id, action: 'employee.resume', entityType: 'employee', entityId: req.params.id, ip: req.ip });
        res.json({ success: true, message: 'Employee resumed successfully' });
    } catch (error) {
        console.error('Resume employee error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Validate reason + last_working_day for hold/abscond/terminate.
// Both mandatory per requirements; LWD must be a valid date, not future,
// and not before joining_date (checked against DB when possible).
function validateStatusChange(body) {
    const errors = [];
    const reason = body && body.reason ? String(body.reason).trim() : '';
    const lwd = body && body.last_working_day ? String(body.last_working_day).trim() : '';
    if (!reason || reason.length < 3) errors.push('Reason is required (min 3 characters)');
    if (reason.length > 1000) errors.push('Reason must be under 1000 characters');
    if (!lwd) errors.push('Last working day is required');
    else {
        const d = new Date(lwd);
        if (isNaN(d.getTime())) errors.push('Last working day must be a valid date (YYYY-MM-DD)');
        else {
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const dd = new Date(d); dd.setHours(0, 0, 0, 0);
            if (dd > today) errors.push('Last working day cannot be in the future');
        }
    }
    return { errors, reason, lwd };
}

async function changeEmployeeStatus(targetId, newStatus, reason, lwd, actorId, ip, auditAction) {
    const cur = await query('SELECT id, employee_id, status, joining_date FROM employees WHERE id = $1', [targetId]);
    if (cur.rows.length === 0) return { ok: false, status: 404, message: 'Employee not found' };
    const emp = cur.rows[0];
    if (emp.status === newStatus) return { ok: false, status: 400, message: 'Employee is already ' + newStatus };
    if (lwd && emp.joining_date) {
        // FIX: joining_date JS Date object ga vasthe String() => "Thu Sep 03..."
        // kabatti toISOString() tho YYYY-MM-DD ki normalize cheyyali.
        let join;
        if (emp.joining_date instanceof Date) {
            join = emp.joining_date.toISOString().substring(0, 10);
        } else {
            const s = String(emp.joining_date).trim();
            if (/^\d{4}-\d{2}-\d{2}/.test(s)) join = s.substring(0, 10);
            else {
                const jd = new Date(emp.joining_date);
                join = !isNaN(jd.getTime()) ? jd.toISOString().substring(0, 10) : s.substring(0, 10);
            }
        }
        if (String(lwd).substring(0, 10) < join) {
            return { ok: false, status: 400, message: 'Last working day cannot be before joining date (' + join + ')' };
        }
    }
    const updated = await runWithSchemaRepair(() => query(
        `UPDATE employees SET status = $1, status_reason = $2, last_working_day = $3,
                status_changed_at = NOW(), status_changed_by = $4,
                token_version = COALESCE(token_version, 0) + 1, updated_at = NOW()
         WHERE id = $5 RETURNING id, employee_id, status, status_reason, last_working_day`,
        [newStatus, reason, lwd, actorId, targetId]
    ));
    try {
        await query(
            `INSERT INTO employee_status_history (employee_id, old_status, new_status, reason, last_working_day, changed_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [targetId, emp.status, newStatus, reason, lwd, actorId]
        );
    } catch (hErr) { console.warn('Status history insert skipped:', hErr.message); }
    logAudit({ actorId, action: auditAction, entityType: 'employee', entityId: targetId,
        details: { from: emp.status, to: newStatus, employee_code: emp.employee_id, reason }, ip });
    return { ok: true, oldStatus: emp.status, employee: updated.rows[0] };
}

// @route   POST /api/employees/:id/hold
// @desc    Put employee account on hold (reason + LWD mandatory, login blocked, data kept)
// @access  Private (Admin)
router.post('/:id/hold', verifyToken, isAdmin, async (req, res) => {
    try {
        if (parseInt(req.params.id) === parseInt(req.user.id)) {
            return res.status(400).json({ success: false, message: 'You cannot hold your own account' });
        }
        const adminGuardError = await adminTargetGuard(req.params.id, req.user.id);
        if (adminGuardError) return res.status(403).json({ success: false, message: adminGuardError });
        const guardError = await lastActiveAdminGuard(req.params.id);
        if (guardError) return res.status(400).json({ success: false, message: guardError });
        const { errors, reason, lwd } = validateStatusChange(req.body);
        if (errors.length > 0) return res.status(400).json({ success: false, errors });
        const r = await changeEmployeeStatus(req.params.id, 'on_hold', reason, lwd, req.user.id, req.ip, 'employee.hold');
        if (!r.ok) return res.status(r.status).json({ success: false, message: r.message });
        res.json({ success: true, message: 'Employee put on hold successfully', employee: r.employee, previous_status: r.oldStatus });
    } catch (error) {
        console.error('Hold employee error:', error);
        const mapped = pgErrorResponse(error);
        res.status(mapped.status).json({ success: false, message: mapped.message });
    }
});

// @route   POST /api/employees/:id/unhold
// @desc    Release an on_hold/paused/inactive employee back to active (same employee_id)
// @access  Private (Admin)
router.post('/:id/unhold', verifyToken, isAdmin, async (req, res) => {
    try {
        const cur = await query('SELECT id, employee_id, status FROM employees WHERE id = $1', [req.params.id]);
        if (cur.rows.length === 0) return res.status(404).json({ success: false, message: 'Employee not found' });
        if (!['on_hold', 'paused', 'inactive'].includes(cur.rows[0].status)) {
            return res.status(400).json({ success: false, message: 'Employee is not on hold' });
        }
        const reason = req.body && req.body.reason ? String(req.body.reason).trim() : 'Released from hold';
        const updated = await runWithSchemaRepair(() => query(
            `UPDATE employees SET status = 'active', status_reason = $2,
                    status_changed_at = NOW(), status_changed_by = $3, updated_at = NOW()
             WHERE id = $1 RETURNING id, employee_id, status`,
            [req.params.id, reason, req.user.id]
        ));
        try {
            await query(
                `INSERT INTO employee_status_history (employee_id, old_status, new_status, reason, changed_by)
                 VALUES ($1, $2, 'active', $3, $4)`,
                [req.params.id, cur.rows[0].status, reason, req.user.id]
            );
        } catch (hErr) { console.warn('Status history insert skipped:', hErr.message); }
        logAudit({ actorId: req.user.id, action: 'employee.unhold', entityType: 'employee',
            entityId: req.params.id, details: { from: cur.rows[0].status, employee_code: cur.rows[0].employee_id }, ip: req.ip });
        res.json({ success: true, message: 'Employee released from hold successfully', employee: updated.rows[0] });
    } catch (error) {
        console.error('Unhold employee error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/employees/:id/abscond
// @desc    Mark employee absconded (reason + LWD mandatory, login blocked, data kept)
// @access  Private (Admin)
router.post('/:id/abscond', verifyToken, isAdmin, async (req, res) => {
    try {
        if (parseInt(req.params.id) === parseInt(req.user.id)) {
            return res.status(400).json({ success: false, message: 'You cannot mark your own account absconded' });
        }
        const adminGuardError = await adminTargetGuard(req.params.id, req.user.id);
        if (adminGuardError) return res.status(403).json({ success: false, message: adminGuardError });
        const guardError = await lastActiveAdminGuard(req.params.id);
        if (guardError) return res.status(400).json({ success: false, message: guardError });
        const { errors, reason, lwd } = validateStatusChange(req.body);
        if (errors.length > 0) return res.status(400).json({ success: false, errors });
        const r = await changeEmployeeStatus(req.params.id, 'absconded', reason, lwd, req.user.id, req.ip, 'employee.abscond');
        if (!r.ok) return res.status(r.status).json({ success: false, message: r.message });
        res.json({ success: true, message: 'Employee marked absconded successfully', employee: r.employee, previous_status: r.oldStatus });
    } catch (error) {
        console.error('Abscond employee error:', error);
        const mapped = pgErrorResponse(error);
        res.status(mapped.status).json({ success: false, message: mapped.message });
    }
});

// @route   POST /api/employees/:id/terminate
// @desc    Terminate with reason + LWD (same employee_id kept, reversible via rehire)
// @access  Private (Admin)
router.post('/:id/terminate', verifyToken, isAdmin, async (req, res) => {
    try {
        const adminGuardError = await adminTargetGuard(req.params.id, req.user.id);
        if (adminGuardError) return res.status(403).json({ success: false, message: adminGuardError });
        const guardError = await lastActiveAdminGuard(req.params.id);
        if (guardError) return res.status(400).json({ success: false, message: guardError });
        const { errors, reason, lwd } = validateStatusChange(req.body);
        if (errors.length > 0) return res.status(400).json({ success: false, errors });
        const r = await changeEmployeeStatus(req.params.id, 'terminated', reason, lwd, req.user.id, req.ip, 'employee.terminate');
        if (!r.ok) return res.status(r.status).json({ success: false, message: r.message });
        res.json({ success: true, message: 'Employee terminated successfully', employee: r.employee, previous_status: r.oldStatus });
    } catch (error) {
        console.error('Terminate employee error:', error);
        const mapped = pgErrorResponse(error);
        res.status(mapped.status).json({ success: false, message: mapped.message });
    }
});

// @route   POST /api/employees/:id/rehire
// @desc    Rehire a terminated/absconded/on_hold employee (same employee_id, data kept)
// @access  Private (Admin)
router.post('/:id/rehire', verifyToken, isAdmin, async (req, res) => {
    try {
        const cur = await query('SELECT id, employee_id, status FROM employees WHERE id = $1', [req.params.id]);
        if (cur.rows.length === 0) return res.status(404).json({ success: false, message: 'Employee not found' });
        if (!['terminated', 'absconded', 'on_hold', 'paused', 'inactive'].includes(cur.rows[0].status)) {
            return res.status(400).json({ success: false, message: 'Only exited employees can be rehired' });
        }
        const reason = req.body && req.body.reason ? String(req.body.reason).trim() : 'Rehired';
        const updated = await runWithSchemaRepair(() => query(
            `UPDATE employees SET status = 'active', status_reason = $2, last_working_day = NULL,
                    status_changed_at = NOW(), status_changed_by = $3, updated_at = NOW()
             WHERE id = $1 RETURNING id, employee_id, status`,
            [req.params.id, reason, req.user.id]
        ));
        try {
            await query(
                `INSERT INTO employee_status_history (employee_id, old_status, new_status, reason, changed_by)
                 VALUES ($1, $2, 'active', $3, $4)`,
                [req.params.id, cur.rows[0].status, reason, req.user.id]
            );
        } catch (hErr) { console.warn('Status history insert skipped:', hErr.message); }
        logAudit({ actorId: req.user.id, action: 'employee.rehire', entityType: 'employee',
            entityId: req.params.id, details: { from: cur.rows[0].status, employee_code: cur.rows[0].employee_id, reason }, ip: req.ip });
        res.json({ success: true, message: 'Employee rehired successfully with same Employee ID', employee: updated.rows[0], previous_status: cur.rows[0].status });
    } catch (error) {
        console.error('Rehire employee error:', error);
        const mapped = pgErrorResponse(error);
        res.status(mapped.status).json({ success: false, message: mapped.message });
    }
});

// @route   DELETE /api/employees/:id
// @desc    Delete employee (soft delete)
// @access  Private (Admin)
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const adminGuardError = await adminTargetGuard(req.params.id, req.user.id);
        if (adminGuardError) {
            return res.status(403).json({ success: false, message: adminGuardError });
        }
        const guardError = await lastActiveAdminGuard(req.params.id);
        if (guardError) {
            return res.status(400).json({ success: false, message: guardError });
        }
        const result = await query(
            `UPDATE employees SET status = 'terminated', updated_at = NOW() 
            WHERE id = $1 RETURNING id`,
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }

        logAudit({ actorId: req.user.id, action: 'employee.terminate', entityType: 'employee', entityId: req.params.id, ip: req.ip });

        res.json({ success: true, message: 'Employee terminated successfully' });
        
    } catch (error) {
        console.error('Delete employee error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   DELETE /api/employees/:id/permanent
// @desc    Permanently delete an employee and ALL related data
// @access  Private (Admin)
router.delete('/:id/permanent', verifyToken, isAdmin, async (req, res) => {
    try {
        if (parseInt(req.params.id) === parseInt(req.user.id)) {
            return res.status(400).json({ success: false, message: 'You cannot permanently delete your own account' });
        }

        const adminGuardError = await adminTargetGuard(req.params.id, req.user.id);
        if (adminGuardError) {
            return res.status(403).json({ success: false, message: adminGuardError });
        }

        const guardError = await lastActiveAdminGuard(req.params.id);
        if (guardError) {
            return res.status(400).json({ success: false, message: guardError });
        }

        const empRes = await query('SELECT * FROM employees WHERE id = $1', [req.params.id]);
        if (empRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        const employee = empRes.rows[0];

        // Collect uploaded files to remove afterwards
        const docRes = await query('SELECT file_name FROM documents WHERE employee_id = $1', [req.params.id]);
        const profilePhoto = employee.profile_photo;

        // Delete related data inside a transaction so a failure mid-way does not
        // leave the employee without their child records (or vice versa).
        const client = await getPool().connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM attendance_photos WHERE employee_id = $1', [req.params.id]);
            await client.query('DELETE FROM attendance WHERE employee_id = $1', [req.params.id]);
            await client.query('DELETE FROM leave_applications WHERE employee_id = $1', [req.params.id]);
            await client.query('DELETE FROM payroll WHERE employee_id = $1', [req.params.id]);
            await client.query('DELETE FROM documents WHERE employee_id = $1', [req.params.id]);
            await client.query('DELETE FROM profile_update_requests WHERE employee_id = $1', [req.params.id]);
            await client.query('DELETE FROM announcement_reads WHERE employee_id = $1', [req.params.id]);
            await client.query('DELETE FROM password_reset_otps WHERE email = $1', [employee.email]);
            await client.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        // Remove associated files from Supabase Storage
        try {
            if (profilePhoto) {
                await deleteFileByUrl(profilePhoto);
            }
            for (const d of docRes.rows) {
                if (d.file_name) {
                    await deleteFile('documents', d.file_name);
                }
            }
        } catch (e) {
            console.error('Permanent delete storage cleanup error:', e.message);
        }

        logAudit({
            actorId: req.user.id,
            action: 'employee.permanent_delete',
            entityType: 'employee',
            entityId: employee.id,
            details: { employee_code: employee.employee_id, email: employee.email },
            ip: req.ip
        });

        res.json({ success: true, message: 'Employee permanently deleted along with all their data' });
    } catch (error) {
        console.error('Permanent delete employee error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
