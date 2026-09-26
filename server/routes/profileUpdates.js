const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdminOrHr } = require('../middleware/auth');
const { sendToUser } = require('../services/push');

const EDITABLE_FIELDS = [
    'gender',
    'date_of_birth',
    'address',
    'permanent_address',
    'languages_spoken',
    'marital_status',
    'personal_email',
    'emergency_contact',
    'emergency_contact_name',
    'blood_group',
    'qualification',
    'specialization',
    'pan_number',
    'aadhaar_number',
    'passport_number',
    'bank_name',
    'bank_branch',
    'bank_account',
    'bank_ifsc'
];

const FIELD_LABELS = {
    gender: 'Gender',
    date_of_birth: 'Date of Birth',
    address: 'Current Address',
    permanent_address: 'Permanent Address',
    languages_spoken: 'Languages Spoken',
    marital_status: 'Marital Status',
    personal_email: 'Personal Email',
    emergency_contact: 'Emergency Contact Number',
    emergency_contact_name: 'Emergency Contact Name',
    blood_group: 'Blood Group',
    qualification: 'Qualification',
    specialization: 'Specialization',
    pan_number: 'PAN Number',
    aadhaar_number: 'Aadhaar Number',
    passport_number: 'Passport Number',
    bank_name: 'Bank Name',
    bank_branch: 'Bank Branch',
    bank_account: 'Bank Account No',
    bank_ifsc: 'IFSC Code'
};

// @route   GET /api/profile-updates
// @desc    List all pending profile update requests (optionally filtered by employee)
// @access  Admin/HR
router.get('/', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const { employee_id, status } = req.query;
        let sqlQuery = `
            SELECT r.*, 
                e.first_name || ' ' || e.last_name as employee_name,
                e.employee_id as emp_id,
                e2.first_name || ' ' || e2.last_name as reviewer_name
            FROM profile_update_requests r
            JOIN employees e ON r.employee_id = e.id
            LEFT JOIN employees e2 ON r.reviewed_by = e2.id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (employee_id) {
            sqlQuery += ` AND r.employee_id = $${paramIndex}`;
            params.push(employee_id);
            paramIndex++;
        }

        if (status) {
            sqlQuery += ` AND r.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        sqlQuery += ' ORDER BY CASE WHEN r.status = \'pending\' THEN 0 ELSE 1 END, r.created_at DESC';

        const result = await query(sqlQuery, params);
        const requests = result.rows.map(r => ({
            ...r,
            field_label: FIELD_LABELS[r.field] || r.field
        }));
        res.json({ success: true, requests });
    } catch (error) {
        console.error('List profile updates error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/profile-updates/:id/approve
// @desc    Approve a pending request and apply the change
// @access  Admin/HR
router.post('/:id/approve', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM profile_update_requests WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        const request = result.rows[0];

        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, message: 'This request has already been reviewed' });
        }

        if (!EDITABLE_FIELDS.includes(request.field)) {
            return res.status(400).json({ success: false, message: 'Field is not editable' });
        }

        let newValue = request.new_value;
        if (newValue !== null && typeof newValue === 'object') {
            newValue = JSON.stringify(newValue);
        }

        const applyResult = await query(
            `UPDATE employees SET ${request.field} = $1, updated_at = NOW() WHERE id = $2`,
            [newValue, request.employee_id]
        );

        const updateResult = await query(
            `UPDATE profile_update_requests SET status = 'approved', reviewed_by = $1, updated_at = NOW()
            WHERE id = $2 RETURNING *`,
            [req.user.id, req.params.id]
        );

        res.json({ success: true, message: 'Request approved and applied', request: updateResult.rows[0] });

        const fieldLabel = FIELD_LABELS[request.field] || request.field;
        try {
            await sendToUser(request.employee_id, {
                title: 'Profile Update Approved',
                body: `Your ${fieldLabel} change was approved`,
                url: '/employee/profile'
            });
        } catch (e) { console.error('Push notify error:', e.message); }
    } catch (error) {
        console.error('Approve profile update error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/profile-updates/:id/reject
// @desc    Reject a pending request
// @access  Admin/HR
router.post('/:id/reject', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const { remarks } = req.body;

        const result = await query(
            'SELECT * FROM profile_update_requests WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        const request = result.rows[0];

        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, message: 'This request has already been reviewed' });
        }

        const updateResult = await query(
            `UPDATE profile_update_requests SET status = 'rejected', reviewed_by = $1, review_remarks = $2, updated_at = NOW()
            WHERE id = $3 RETURNING *`,
            [req.user.id, remarks || null, req.params.id]
        );

        res.json({ success: true, message: 'Request rejected', request: updateResult.rows[0] });

        const fieldLabel = FIELD_LABELS[request.field] || request.field;
        try {
            await sendToUser(request.employee_id, {
                title: 'Profile Update Rejected',
                body: `Your ${fieldLabel} change was rejected`,
                url: '/employee/profile'
            });
        } catch (e) { console.error('Push notify error:', e.message); }
    } catch (error) {
        console.error('Reject profile update error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
module.exports.EDITABLE_FIELDS = EDITABLE_FIELDS;
