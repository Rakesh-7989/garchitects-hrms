const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../config/database');
const { verifyToken, generateToken } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { validateLogin, collectFieldErrors } = require('../middleware/validation');
const { sendOTPEmail } = require('../services/email');
const { uploadBuffer } = require('../services/storage');
const { EDITABLE_FIELDS } = require('./profileUpdates');
const { rateLimit, clientIp } = require('../utils/rateLimit');

const uploadProfile = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1 * 1024 * 1024 }, fileFilter: (req, file, cb) => { const allowed = /jpeg|jpg|png|gif/; const ext = allowed.test(path.extname(file.originalname).toLowerCase()); const mime = allowed.test(file.mimetype); cb(null, ext && mime); } });

// Brute-force protection. Per-IP for login (pre-login there is nothing else to
// key on), per-account for authenticated password endpoints.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyFn: (req) => 'login:' + clientIp(req),
    message: 'Too many login attempts from this network. Please try again in a few minutes.'
});

const passwordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyFn: (req) => 'pwd:' + (req.user ? req.user.id : clientIp(req)),
    message: 'Too many password attempts. Please try again later.'
});

// Constant bcrypt hash used only to equalize the response time of the
// "unknown user" path with the "wrong password" path (prevents user
// enumeration by timing). Computed once at startup.
const TIMING_EQUALIZER_HASH = bcrypt.hashSync('garchitects-timing-equalizer-' + Math.random(), 12);

// ---------- Forgot password (OTP over email) ----------
// The password_reset_otps table + sendOTPEmail service already existed; these
// endpoints finally wire them up so users can self-reset without admin help.

const forgotLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyFn: (req) => 'forgot:' + clientIp(req),
    message: 'Too many reset requests. Please try again later.'
});

const otpResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyFn: (req) => 'otpreset:' + clientIp(req),
    message: 'Too many attempts. Please try again later.'
});

function hashOtp(otp) {
    // Short-lived 6-digit codes don't need bcrypt; a peppered SHA-256 keeps
    // a database leak from exposing usable codes.
    const pepper = process.env.JWT_SECRET || 'garchitects-otp-pepper';
    return crypto.createHash('sha256').update(String(otp) + ':' + pepper).digest('hex');
}

// @route   POST /api/auth/forgot-password
// @desc    Email a one-time 6-digit code for password self-reset
// @access  Public (rate limited)
router.post('/forgot-password', forgotLimiter, async (req, res) => {
    try {
        const identifier = String((req.body && req.body.employee_id) || '').trim();
        if (!identifier) {
            return res.status(400).json({ success: false, message: 'Employee ID or email is required' });
        }

        const result = await query(
            `SELECT id, employee_id, email, personal_email FROM employees
            WHERE (LOWER(employee_id) = LOWER($1) OR LOWER(email) = LOWER($1)
                OR LOWER(personal_email) = LOWER($1)) AND status = $2
            LIMIT 1`,
            [identifier, 'active']
        );

        // Be explicit: an identifier that does not match any active account
        // (employee ID, office email or personal email) is simply invalid -
        // no OTP is generated for unknown users.
        if (result.rows.length === 0 || !result.rows[0].email) {
            return res.status(404).json({ success: false, message: 'Invalid Employee ID or Email' });
        }

        const user = result.rows[0];
        // Deliver the code to the personal address when available - work
        // inboxes may be inaccessible while the employee is locked out.
        // The code itself stays keyed to the unique office email so the
        // reset-password lookup keeps working unchanged.
        const deliveryEmail = user.personal_email || user.email;

        // Only one live code per account - older ones become unusable.
        await query(
            'UPDATE password_reset_otps SET is_used = 1 WHERE email = $1 AND is_used = 0',
            [user.email]
        );

        const otp = crypto.randomInt(100000, 999999);
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        await query(
            'INSERT INTO password_reset_otps (email, otp, is_used, expires_at) VALUES ($1, $2, 0, $3)',
            [user.email, hashOtp(otp), expiresAt]
        );

        const sent = await sendOTPEmail(deliveryEmail, otp, { empId: user.employee_id });
        if (!sent) {
            console.error('Forgot password: OTP email not sent (SMTP not configured). deliveryEmail=' + deliveryEmail);
            return res.status(502).json({ success: false, message: 'Email service is not configured. Contact your administrator.' });
        }

        res.json({ success: true, message: 'Reset code sent to your registered email. Valid for 5 minutes.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/auth/verify-reset-otp
// @desc    Check a reset code is valid WITHOUT consuming it - used by the
//          UI to verify the code before revealing the new-password fields.
// @access  Public (rate limited)
router.post('/verify-reset-otp', otpResetLimiter, async (req, res) => {
    try {
        const identifier = String((req.body && req.body.employee_id) || '').trim();
        const otp = String((req.body && req.body.otp) || '').trim();
        if (!identifier || !otp) {
            return res.status(400).json({ success: false, message: 'Identifier and code are required' });
        }

        const result = await query(
            `SELECT id, email FROM employees
            WHERE (LOWER(employee_id) = LOWER($1) OR LOWER(email) = LOWER($1)
                OR LOWER(personal_email) = LOWER($1)) AND status = $2
            LIMIT 1`,
            [identifier, 'active']
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired code' });
        }
        const user = result.rows[0];

        const otpRows = await query(
            `SELECT id, otp AS otp_hash FROM password_reset_otps
            WHERE email = $1 AND is_used = 0 AND expires_at > NOW()
            ORDER BY id DESC LIMIT 1`,
            [user.email]
        );

        const storedHash = otpRows.rows.length > 0 ? otpRows.rows[0].otp_hash : null;
        const providedHash = hashOtp(otp);
        let match = storedHash !== null && storedHash.length === providedHash.length;
        if (match) {
            match = crypto.timingSafeEqual(Buffer.from(storedHash), Buffer.from(providedHash));
        }
        if (!match) {
            return res.status(400).json({ success: false, message: 'Invalid or expired code' });
        }
        res.json({ success: true, message: 'Code verified! Now set your new password.' });
    } catch (error) {
        console.error('Verify reset OTP error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/auth/reset-password
// @desc    Verify OTP and set a new password (revokes all existing sessions)
// @access  Public (rate limited)
router.post('/reset-password', otpResetLimiter, async (req, res) => {
    try {
        const identifier = String((req.body && req.body.employee_id) || '').trim();
        const otp = String((req.body && req.body.otp) || '').trim();
        const new_password = String((req.body && req.body.new_password) || '');

        if (!identifier || !otp || !new_password) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }
        if (new_password.length < 6) {
            return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
        }

        const result = await query(
            `SELECT id, email FROM employees
            WHERE (LOWER(employee_id) = LOWER($1) OR LOWER(email) = LOWER($1)
                OR LOWER(personal_email) = LOWER($1)) AND status = $2
            LIMIT 1`,
            [identifier, 'active']
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired code' });
        }
        const user = result.rows[0];

        const otpRows = await query(
            `SELECT id, otp AS otp_hash FROM password_reset_otps
            WHERE email = $1 AND is_used = 0 AND expires_at > NOW()
            ORDER BY id DESC LIMIT 1`,
            [user.email]
        );

        const storedHash = otpRows.rows.length > 0 ? otpRows.rows[0].otp_hash : null;
        const providedHash = hashOtp(otp);
        // Compare every byte even when no row exists (timing hygiene).
        let match = storedHash !== null && storedHash.length === providedHash.length;
        if (match) {
            match = crypto.timingSafeEqual(Buffer.from(storedHash), Buffer.from(providedHash));
        }
        if (!match) {
            return res.status(400).json({ success: false, message: 'Invalid or expired code' });
        }

        // Consume the code (and any siblings), set the new password, and bump
        // token_version so other devices are signed out everywhere.
        await query('UPDATE password_reset_otps SET is_used = 1 WHERE email = $1 AND is_used = 0', [user.email]);
        const salt = await bcrypt.genSalt(12);
        const password_hash = await bcrypt.hash(new_password, salt);
        await query(
            `UPDATE employees SET password_hash = $1, must_change_password = 0,
                token_version = COALESCE(token_version, 0) + 1, updated_at = NOW()
            WHERE id = $2`,
            [password_hash, user.id]
        );

        res.json({ success: true, message: 'Password reset successful. Please sign in with your new password.' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Bump token_version and return a fresh token for the current session.
// All other devices/tabs are signed out immediately; this one stays logged in.
async function rotatePasswordCredential(userId) {
    await query(
        `UPDATE employees SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1`,
        [userId]
    );
    const fresh = await query('SELECT * FROM employees WHERE id = $1', [userId]);
    if (fresh.rows.length === 0) return null;
    const { password_hash, ...userWithoutPassword } = fresh.rows[0];
    return { token: generateToken(fresh.rows[0]), user: userWithoutPassword };
}

// @route   POST /api/auth/login
// @desc    Login user (Admin/Employee)
// @access  Public
router.post('/login', loginLimiter, validateLogin, async (req, res) => {
    try {
        const { employee_id, password, portal } = req.body;

        // Find user by employee ID or email
        const result = await query(
            `SELECT * FROM employees 
            WHERE (LOWER(employee_id) = LOWER($1) OR LOWER(email) = LOWER($1)) AND status = $2`,
            [employee_id, 'active']
        );
        
        if (result.rows.length === 0) {
            // Burn the same bcrypt time as the found-user path so attackers
            // cannot enumerate valid Employee IDs by response timing.
            await bcrypt.compare(password, TIMING_EQUALIZER_HASH);
            // Status-aware message: check if the ID exists but is not active
            // (on_hold / absconded / terminated / paused / inactive) so the
            // employee knows why login is blocked. Password is NOT verified
            // here, so no credential leak — only the account state is shared.
            let statusMessage = 'Invalid Employee ID or password';
            try {
                const stRes = await query(
                    `SELECT status FROM employees
                     WHERE LOWER(employee_id) = LOWER($1) OR LOWER(email) = LOWER($1) LIMIT 1`,
                    [employee_id]
                );
                if (stRes.rows.length > 0) {
                    const st = stRes.rows[0].status;
                    if (st === 'on_hold') statusMessage = 'Your account is on hold. Please contact HR.';
                    else if (st === 'absconded') statusMessage = 'Your account is marked absconded. Please contact HR.';
                    else if (st === 'terminated') statusMessage = 'Your account has been terminated. Please contact HR.';
                    else if (st === 'paused') statusMessage = 'Your account is paused. Please contact your administrator.';
                    else if (st === 'inactive') statusMessage = 'Your account is inactive. Please contact your administrator.';
                }
            } catch (stErr) { /* keep generic message on DB error */ }
            logAudit({
                action: 'auth.login_failed',
                entityType: 'employee',
                entityId: null,
                details: { identifier: String(employee_id || ''), reason: 'unknown_user_or_inactive' },
                ip: req.ip
            });
            return res.status(401).json({
                success: false,
                message: statusMessage
            });
        }
        
        const user = result.rows[0];
        
        // Check password
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        
        if (!isPasswordValid) {
            logAudit({
                actorId: user.id,
                action: 'auth.login_failed',
                entityType: 'employee',
                entityId: user.id,
                details: { reason: 'wrong_password' },
                ip: req.ip
            });
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid Employee ID or password' 
            });
        }

        // Portal role enforcement
        if (portal === 'admin') {
            if (user.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'This account does not have Admin access. Use the Employee Portal.'
                });
            }
        } else if (portal === 'employee') {
            if (user.role === 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'Admin accounts must sign in through the Admin Portal.'
                });
            }
        }
        
        // Generate token
        const token = generateToken(user);
        
        logAudit({
            actorId: user.id,
            action: 'auth.login_success',
            entityType: 'employee',
            entityId: user.id,
            details: { portal: portal || 'employee' },
            ip: req.ip
        });

        // Return user info (without password)
        const { password_hash, ...userWithoutPassword } = user;
        
        res.json({
            success: true,
            message: 'Login successful',
            token,
            must_change_password: user.must_change_password === 1 || user.must_change_password === true,
            user: userWithoutPassword
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error during login' 
        });
    }
});


// @route   GET /api/auth/me
// @desc    Get current user profile
// @access  Private
router.get('/me', verifyToken, async (req, res) => {
    try {
        const result = await query(
            `SELECT e.*, d.name as department_name, des.name as designation_name, des.level as designation_level,
            rm.first_name || ' ' || rm.last_name as reporting_manager_name, rm.employee_id as reporting_manager_employee_id,
            srm.first_name || ' ' || srm.last_name as secondary_reporting_manager_name, srm.employee_id as secondary_reporting_manager_employee_id
            FROM employees e 
            LEFT JOIN departments d ON e.department_id = d.id 
            LEFT JOIN designations des ON e.designation_id = des.id 
            LEFT JOIN employees rm ON e.reporting_manager_id = rm.id
            LEFT JOIN employees srm ON e.secondary_reporting_manager_id = srm.id
            WHERE e.id = $1`,
            [req.user.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found' 
            });
        }
        
        const user = result.rows[0];
        delete user.password_hash;
        
        res.json({
            success: true,
            user
        });
        
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error' 
        });
    }
});

// @route   PUT /api/auth/change-password
// @desc    Change user password
// @access  Private
router.put('/change-password', verifyToken, passwordLimiter, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        
        if (!current_password || !new_password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Current and new password are required' 
            });
        }
        
        if (new_password.length < 6) {
            return res.status(400).json({ 
                success: false, 
                message: 'New password must be at least 6 characters' 
            });
        }
        
        // Get current password hash
        const result = await query(
            'SELECT password_hash FROM employees WHERE id = $1',
            [req.user.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found' 
            });
        }
        
        // Verify current password
        const isPasswordValid = await bcrypt.compare(
            current_password, 
            result.rows[0].password_hash
        );
        
        if (!isPasswordValid) {
            return res.status(401).json({ 
                success: false, 
                message: 'Current password is incorrect' 
            });
        }
        
        // Hash new password
        const salt = await bcrypt.genSalt(12);
        const password_hash = await bcrypt.hash(new_password, salt);
        
        // Update password and clear must_change_password flag. rotatePasswordCredential
        // below bumps token_version, revoking all previously issued tokens.
        await query(
            'UPDATE employees SET password_hash = $1, must_change_password = 0, updated_at = NOW() WHERE id = $2',
            [password_hash, req.user.id]
        );

        const rotated = await rotatePasswordCredential(req.user.id);

        res.json({
            success: true,
            message: 'Password changed successfully',
            token: rotated ? rotated.token : undefined
        });
        
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error' 
        });
    }
});

// @route   POST /api/auth/set-password
// @desc    Set a new password on first login after admin reset (forced change)
// @access  Private
router.post('/set-password', verifyToken, passwordLimiter, async (req, res) => {
    try {
        const { new_password } = req.body;

        if (!new_password || new_password.length < 6) {
            return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
        }

        const result = await query(
            'SELECT must_change_password FROM employees WHERE id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!(result.rows[0].must_change_password === 1 || result.rows[0].must_change_password === true)) {
            return res.status(400).json({ success: false, message: 'Password change is not required' });
        }

        const salt = await bcrypt.genSalt(12);
        const password_hash = await bcrypt.hash(new_password, salt);

        await query(
            'UPDATE employees SET password_hash = $1, must_change_password = 0, updated_at = NOW() WHERE id = $2',
            [password_hash, req.user.id]
        );

        const rotated = await rotatePasswordCredential(req.user.id);

        res.json({ success: true, message: 'Password set successfully', token: rotated ? rotated.token : undefined });
    } catch (error) {
        console.error('Set password error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/auth/logout
// @desc    Logout user (client-side token removal)
// @access  Private
router.post('/logout', verifyToken, (req, res) => {
    res.json({
        success: true,
        message: 'Logged out successfully'
    });
});

// @route   POST /api/auth/profile-photo
// @desc    Upload profile photo
// @access  Private
router.post('/profile-photo', verifyToken, uploadProfile.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        
        const ext = path.extname(req.file.originalname).toLowerCase();
        const fileName = `profile-${req.user.id}-${Date.now()}${ext}`;
        const photoUrl = await uploadBuffer('profile-photos', fileName, req.file.buffer, req.file.mimetype);
        
        await query(
            'UPDATE employees SET profile_photo = $1, updated_at = NOW() WHERE id = $2',
            [photoUrl, req.user.id]
        );
        
        res.json({ success: true, photo_url: photoUrl });
    } catch (error) {
        console.error('Profile photo upload error:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/auth/profile-request
// @desc    Submit profile change request(s) for admin approval
// @access  Private
router.post('/profile-request', verifyToken, async (req, res) => {
    try {
        const changes = req.body.changes || req.body;

        if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) {
            return res.status(400).json({ success: false, message: 'No changes provided' });
        }

        const fieldErrors = collectFieldErrors(changes);
        if (fieldErrors.length > 0) {
            return res.status(400).json({ success: false, errors: fieldErrors });
        }

        const employeeResult = await query(
            `SELECT * FROM employees WHERE id = $1`,
            [req.user.id]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const current = employeeResult.rows[0];
        const created = [];

        for (const [field, newValue] of Object.entries(changes)) {
            if (!EDITABLE_FIELDS.includes(field)) continue;

            let oldValue = current[field] != null ? String(current[field]) : '';
            const nextValue = newValue != null ? String(newValue) : '';

            if (field === 'date_of_birth' && oldValue) {
                const d = new Date(current[field]);
                if (!isNaN(d.getTime())) oldValue = d.toISOString().split('T')[0];
            }

            if (oldValue === nextValue) continue;
            if (nextValue === '') continue;

            const result = await query(
                `INSERT INTO profile_update_requests (employee_id, field, old_value, new_value, status)
                VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
                [req.user.id, field, oldValue, nextValue]
            );
            created.push(result.rows[0]);
        }

        if (created.length === 0) {
            return res.json({ success: true, message: 'No changes to submit', requests: [] });
        }

        res.status(201).json({
            success: true,
            message: `${created.length} change request(s) submitted for admin approval`,
            requests: created
        });
    } catch (error) {
        console.error('Profile request error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/auth/profile-requests
// @desc    Get current user's profile update requests
// @access  Private
router.get('/profile-requests', verifyToken, async (req, res) => {
    try {
        const result = await query(
            `SELECT r.*, e.first_name || ' ' || e.last_name as reviewer_name
            FROM profile_update_requests r
            LEFT JOIN employees e ON r.reviewed_by = e.id
            WHERE r.employee_id = $1
            ORDER BY r.created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, requests: result.rows });
    } catch (error) {
        console.error('Get profile requests error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/auth/profile-request/:id/cancel
// @desc    Cancel a pending profile update request
// @access  Private
router.post('/profile-request/:id/cancel', verifyToken, async (req, res) => {
    try {
        const check = await query(
            'SELECT id FROM profile_update_requests WHERE id = $1 AND employee_id = $2 AND status = $3',
            [req.params.id, req.user.id, 'pending']
        );

        if (check.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Pending request not found' });
        }

        const result = await query(
            `UPDATE profile_update_requests SET status = 'cancelled', updated_at = NOW()
            WHERE id = $1 RETURNING id, status`,
            [req.params.id]
        );

        res.json({ success: true, message: 'Request cancelled', request: result.rows[0] });
    } catch (error) {
        console.error('Cancel profile request error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
