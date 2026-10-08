const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

// @route   GET /api/departments
router.get('/', verifyToken, async (req, res) => {
    try {
        const result = await query(
            `SELECT d.*, COUNT(e.id) as employee_count 
            FROM departments d 
            LEFT JOIN employees e ON d.id = e.department_id AND e.status = 'active' AND e.role != 'admin'
            GROUP BY d.id 
            ORDER BY d.name`
        );
        res.json({ success: true, departments: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/departments
router.post('/', verifyToken, isAdmin, async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
        
        const result = await query(
            'INSERT INTO departments (name, description) VALUES ($1, $2) RETURNING *',
            [name, description]
        );
        logAudit({ actorId: req.user.id, action: 'department.create', entityType: 'department', entityId: result.rows[0].id, details: { name }, ip: req.ip });
        res.status(201).json({ success: true, department: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   PUT /api/departments/:id
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const { name, description } = req.body;
        const result = await query(
            'UPDATE departments SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3 RETURNING *',
            [name, description, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
        logAudit({ actorId: req.user.id, action: 'department.update', entityType: 'department', entityId: result.rows[0].id, details: { fields: Object.keys(req.body || {}) }, ip: req.ip });
        res.json({ success: true, department: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   DELETE /api/departments/:id
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await query('DELETE FROM departments WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
        logAudit({ actorId: req.user.id, action: 'department.delete', entityType: 'department', entityId: result.rows[0].id, details: {}, ip: req.ip });
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Cannot delete: department has employees' });
    }
});

module.exports = router;
