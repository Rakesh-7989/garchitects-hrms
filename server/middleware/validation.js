// Input validation middleware

// Single source of truth for the minimum password length, enforced on all entry
// points (create, OTP reset, change-password, admin reset) — audit-security F8.
const MIN_PASSWORD_LEN = 8;

const validateEmail = (email) => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
};

const validatePhone = (phone) => {
    const re = /^[\+]?[0-9]{10,15}$/;
    return re.test(phone.replace(/\s/g, ''));
};

const validatePassword = (password) => {
    return password && password.length >= MIN_PASSWORD_LEN;
};

const validatePan = (pan) => {
    if (!pan || pan.trim() === '') return true;
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan.trim().toUpperCase());
};

const validateAadhaar = (aadhaar) => {
    if (!aadhaar || aadhaar.trim() === '') return true;
    return /^\d{12}$/.test(aadhaar.trim());
};

const validateIfsc = (ifsc) => {
    if (!ifsc || ifsc.trim() === '') return true;
    return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.trim().toUpperCase());
};

// Validate optional sensitive fields; returns an array of error messages
const collectFieldErrors = (payload) => {
    const errors = [];
    if (payload.pan_number && !validatePan(payload.pan_number)) {
        errors.push('PAN Number must be in format ABCDE1234F (5 letters, 4 digits, 1 letter)');
    }
    if (payload.aadhaar_number && !validateAadhaar(payload.aadhaar_number)) {
        errors.push('Aadhaar Number must be exactly 12 digits');
    }
    if (payload.bank_ifsc && !validateIfsc(payload.bank_ifsc)) {
        errors.push('IFSC Code must be in format ABCD0123456');
    }
    if (payload.personal_email && !validateEmail(payload.personal_email)) {
        errors.push('Valid personal email is required');
    }
    if (payload.gender && !['male', 'female', 'other'].includes(String(payload.gender).toLowerCase())) {
        errors.push('Gender must be Male, Female or Other');
    }
    if (payload.date_of_birth) {
        const dob = new Date(payload.date_of_birth);
        if (isNaN(dob.getTime())) {
            errors.push('Valid date of birth is required');
        } else if (dob > new Date()) {
            errors.push('Date of birth cannot be in the future');
        }
    }
    return errors;
};

// Validate Registration
const validateRegistration = (req, res, next) => {
    const { email, password, first_name, last_name } = req.body;
    
    const errors = [];
    
    if (!first_name || first_name.trim().length < 2) {
        errors.push('First name is required (min 2 characters)');
    }
    
    if (!last_name || last_name.trim().length < 2) {
        errors.push('Last name is required (min 2 characters)');
    }
    
    if (!email || !validateEmail(email)) {
        errors.push('Valid email is required');
    }
    
    if (!password || !validatePassword(password)) {
        errors.push('Password is required (min 8 characters)');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({ 
            success: false, 
            errors 
        });
    }
    
    next();
};

// Validate Login
const validateLogin = (req, res, next) => {
    const { employee_id, password } = req.body;
    
    if (!employee_id || String(employee_id).trim() === '') {
        return res.status(400).json({ 
            success: false, 
            message: 'Employee ID is required' 
        });
    }
    
    if (!password) {
        return res.status(400).json({ 
            success: false, 
            message: 'Password is required' 
        });
    }
    
    next();
};

// Validate Employee Data
const validateEmployee = (req, res, next) => {
    const { email, first_name, last_name, employee_id, joining_date } = req.body;
    
    const errors = [];
    
    if (!employee_id || employee_id.trim().length < 3) {
        errors.push('Employee ID is required (min 3 characters)');
    }
    
    if (!first_name || first_name.trim().length < 2) {
        errors.push('First name is required');
    }
    
    if (!last_name || last_name.trim().length < 2) {
        errors.push('Last name is required');
    }
    
    if (!email || !validateEmail(email)) {
        errors.push('Valid email is required');
    }
    
    if (!joining_date) {
        errors.push('Joining date is required');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({ 
            success: false, 
            errors 
        });
    }
    
    next();
};

// Validate Leave Application
const validateLeave = (req, res, next) => {
    const { leave_type_id, start_date, end_date } = req.body;
    
    const errors = [];
    
    if (!leave_type_id) {
        errors.push('Leave type is required');
    }
    
    if (!start_date) {
        errors.push('Start date is required');
    }
    
    if (!end_date) {
        errors.push('End date is required');
    }
    
    if (start_date && end_date && new Date(start_date) > new Date(end_date)) {
        errors.push('End date must be after start date');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({ 
            success: false, 
            errors 
        });
    }
    
    next();
};

module.exports = { 
    MIN_PASSWORD_LEN,
    validateRegistration, 
    validateLogin, 
    validateEmployee, 
    validateLeave,
    validateEmail,
    validatePhone,
    validatePassword,
    validatePan,
    validateAadhaar,
    validateIfsc,
    collectFieldErrors
};
