const jwt = require('jsonwebtoken');
require('dotenv').config();
const { query } = require('../config/database');
const { runWithSchemaRepair } = require('../utils/schemaRepair');

// Verify JWT Token and check the user is still active in the database
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
            success: false, 
            message: 'Access denied. No token provided.' 
        });
    }
    
    const token = authHeader.split(' ')[1];
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;

        // Ensure the account still exists and is active (blocks terminated/paused/deleted users).
        // Also re-read the current role so role changes (e.g. demotions) take effect
        // immediately instead of waiting for the JWT to expire. token_version is
        // bumped whenever the password changes or an admin resets it, which
        // instantly revokes every token issued before that moment.
        try {
            // Wrapped in schema repair so a freshly-deployed release that needs
            // a new column (e.g. token_version) self-heals on the first request
            // instead of failing every authenticated call with a 500.
            const result = await runWithSchemaRepair(
                () => query('SELECT id, role, status, token_version, must_change_password FROM employees WHERE id = $1', [decoded.id])
            );
            if (result.rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: 'Account no longer exists.'
                });
            }
            const current = result.rows[0];
            if (current.status !== 'active') {
                let msg = 'Your account has been deactivated. Contact your administrator.';
                if (current.status === 'on_hold') msg = 'Your account is on hold. Please contact HR.';
                else if (current.status === 'absconded') msg = 'Your account is marked absconded. Please contact HR.';
                else if (current.status === 'terminated') msg = 'Your account has been terminated. Please contact HR.';
                else if (current.status === 'paused') msg = 'Your account is paused. Please contact your administrator.';
                else if (current.status === 'inactive') msg = 'Your account is inactive. Please contact your administrator.';
                return res.status(401).json({
                    success: false,
                    message: msg,
                    status: current.status
                });
            }
            if (Number(decoded.token_version || 0) !== Number(current.token_version || 0)) {
                return res.status(401).json({
                    success: false,
                    message: 'Session expired due to a password change. Please sign in again.'
                });
            }
            req.user.role = current.role;

            // PASSWORD LOCK (server-side must_change_password enforcement).
            // A temp password issued by an admin must not remain usable via the
            // API forever: until the user sets their own password they may only
            // reach the password/account surface (mirrors the frontend redirect
            // to the profile page and its admin exemption). Everything else is
            // refused with a dedicated code so clients can react explicitly.
            if ((current.must_change_password === 1 || current.must_change_password === true) && req.user.role !== 'admin') {
                const fullPath = ((req.originalUrl || req.url || '') + '').split('?')[0];
                const isPasswordSurface =
                    fullPath.indexOf('/auth/me') !== -1 ||
                    fullPath.indexOf('/auth/change-password') !== -1 ||
                    fullPath.indexOf('/auth/set-password') !== -1 ||
                    fullPath.indexOf('/auth/logout') !== -1 ||
                    fullPath.indexOf('/auth/profile-photo') !== -1 ||
                    fullPath.indexOf('/auth/profile-request') !== -1;
                if (!isPasswordSurface) {
                    return res.status(403).json({
                        success: false,
                        code: 'PASSWORD_CHANGE_REQUIRED',
                        message: 'You must set a new password before continuing.'
                    });
                }
            }
        } catch (dbError) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }

        next();
    } catch (error) {
        return res.status(401).json({ 
            success: false, 
            message: 'Invalid or expired token.' 
        });
    }
};

// Check if user is Admin
const isAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ 
            success: false, 
            message: 'Access denied. Admin role required.' 
        });
    }
    next();
};

// Check if user is Manager or above
const isManager = (req, res, next) => {
    const allowedRoles = ['admin', 'manager', 'team_lead', 'hr'];
    if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ 
            success: false, 
            message: 'Access denied. Manager role or above required.' 
        });
    }
    next();
};

// Check if user is Employee
const isEmployee = (req, res, next) => {
    const allowedRoles = ['employee'];
    if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ 
            success: false, 
            message: 'Access denied. Employee role required.' 
        });
    }
    next();
};

// Generate JWT Token
const generateToken = (user) => {
    return jwt.sign(
        {
            id: user.id,
            employee_id: user.employee_id,
            email: user.email,
            role: user.role,
            name: `${user.first_name} ${user.last_name}`,
            token_version: Number(user.token_version || 0)
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
};

// Which announcement target_audience values a given role may see.
// team_lead counts as manager-level; hr/manager/team_lead are also employees.
const audienceForRole = (role) => {
    switch (role) {
        case 'admin': return ['all', 'admin'];
        case 'hr': return ['all', 'hr', 'employee'];
        case 'manager':
        case 'team_lead': return ['all', 'manager', 'employee'];
        default: return ['all', 'employee'];
    }
};

module.exports = { 
    verifyToken, 
    isAdmin, 
    isManager, 
    isEmployee,
    generateToken,
    audienceForRole
};
