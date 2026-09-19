-- ============================================
-- G-Architects HRMS - Supabase (PostgreSQL) Schema
-- Inspired by Keka HR
-- Run this in the Supabase SQL editor (or `npm run db:init`)
-- ============================================

-- 1. COMPANIES
CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    logo VARCHAR(500),
    address TEXT,
    phone VARCHAR(20),
    email VARCHAR(255) UNIQUE,
    website VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. DEPARTMENTS
CREATE TABLE IF NOT EXISTS departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    company_id INT REFERENCES companies(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. DESIGNATIONS
CREATE TABLE IF NOT EXISTS designations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    level INT DEFAULT 1,
    department_id INT REFERENCES departments(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 4. EMPLOYEES
CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    employee_id VARCHAR(50) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20),
    password_hash VARCHAR(255) NOT NULL,
    department_id INT REFERENCES departments(id) ON DELETE SET NULL,
    designation_id INT REFERENCES designations(id) ON DELETE SET NULL,
    reporting_manager_id INT REFERENCES employees(id) ON DELETE SET NULL,
    joining_date DATE NOT NULL,
    salary DECIMAL(10,2),
    profile_photo VARCHAR(500),
    role VARCHAR(20) DEFAULT 'employee' CHECK (role IN ('admin', 'hr', 'manager', 'team_lead', 'employee')),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'paused', 'terminated', 'on_hold', 'absconded')),
    status_reason TEXT,
    status_changed_at TIMESTAMP DEFAULT NOW(),
    status_changed_by INT REFERENCES employees(id) ON DELETE SET NULL,
    last_working_day DATE,
    address TEXT,
    date_of_birth DATE,
    gender VARCHAR(10),
    blood_group VARCHAR(5),
    emergency_contact VARCHAR(20),
    emergency_contact_name VARCHAR(100),
    must_change_password INTEGER DEFAULT 0,
    permanent_address TEXT,
    languages_spoken TEXT,
    marital_status TEXT,
    personal_email TEXT,
    qualification TEXT,
    specialization TEXT,
    pan_number TEXT,
    aadhaar_number TEXT,
    passport_number TEXT,
    bank_name TEXT,
    bank_branch TEXT,
    bank_account TEXT,
    bank_ifsc TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 4b. EMPLOYEE STATUS HISTORY (additive: tracks hold/abscond/terminate/rehire, never deletes)
CREATE TABLE IF NOT EXISTS employee_status_history (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    old_status VARCHAR(20),
    new_status VARCHAR(20) NOT NULL,
    reason TEXT NOT NULL,
    last_working_day DATE,
    changed_by INT REFERENCES employees(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_status_history_employee ON employee_status_history(employee_id, created_at DESC);

-- 5. ATTENDANCE
CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    check_in TIME,
    check_out TIME,
    break_start TIME,
    break_end TIME,
    break_log TEXT,
    status VARCHAR(20) DEFAULT 'present' CHECK (status IN ('present', 'absent', 'half-day', 'late', 'holiday', 'weekoff', 'wfh')),
    overtime_hours DECIMAL(4,2) DEFAULT 0,
    remarks TEXT,
    check_in_location TEXT,
    check_out_location TEXT,
    photo_token TEXT,
    photo_token_checkout TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(employee_id, date)
);

-- 6. LEAVE TYPES
CREATE TABLE IF NOT EXISTS leave_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    days_per_year INT NOT NULL,
    description TEXT,
    gender_eligibility VARCHAR(10) DEFAULT 'all' CHECK (gender_eligibility IN ('all', 'male', 'female')),
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 7. LEAVE APPLICATIONS
CREATE TABLE IF NOT EXISTS leave_applications (
    id SERIAL PRIMARY KEY,
    employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    leave_type_id INT REFERENCES leave_types(id) ON DELETE SET NULL,
    reporting_manager_id INT REFERENCES employees(id) ON DELETE SET NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    total_days INT NOT NULL,
    reason TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    approved_by INT REFERENCES employees(id) ON DELETE SET NULL,
    approval_remarks TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 8. WFH REQUESTS
CREATE TABLE IF NOT EXISTS wfh_requests (
    id SERIAL PRIMARY KEY,
    employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    reporting_manager_id INT REFERENCES employees(id) ON DELETE SET NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    total_days INT NOT NULL,
    reason TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    approved_by INT REFERENCES employees(id) ON DELETE SET NULL,
    approval_remarks TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 9. HOLIDAYS
CREATE TABLE IF NOT EXISTS holidays (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    date DATE NOT NULL,
    description TEXT,
    company_id INT REFERENCES companies(id) ON DELETE SET NULL,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(name, date)
);

-- 10. SUPPORT TICKETS
CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    reporting_manager_id INT REFERENCES employees(id) ON DELETE SET NULL,
    category VARCHAR(100) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    description TEXT,
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    admin_response TEXT,
    responded_by INT REFERENCES employees(id) ON DELETE SET NULL,
    responded_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 11. ANNOUNCEMENTS
CREATE TABLE IF NOT EXISTS announcements (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    posted_by INT REFERENCES employees(id) ON DELETE SET NULL,
    target_audience VARCHAR(50) DEFAULT 'all' CHECK (target_audience IN ('all', 'admin', 'hr', 'manager', 'employee')),
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 12. ANNOUNCEMENT READS
CREATE TABLE IF NOT EXISTS announcement_reads (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    announcement_id INT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(employee_id, announcement_id)
);

-- 13. PAYROLL
CREATE TABLE IF NOT EXISTS payroll (
    id SERIAL PRIMARY KEY,
    employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
    year INT NOT NULL,
    basic_salary DECIMAL(10,2),
    allowances DECIMAL(10,2) DEFAULT 0,
    deductions DECIMAL(10,2) DEFAULT 0,
    net_salary DECIMAL(10,2),
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'processed', 'paid')),
    payment_date DATE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(employee_id, month, year)
);

-- 14. DOCUMENTS
CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    file_url VARCHAR(500),
    file_name VARCHAR(500),
    document_type VARCHAR(100),
    uploaded_by INT REFERENCES employees(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 15. PASSWORD RESET OTPS
CREATE TABLE IF NOT EXISTS password_reset_otps (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    otp TEXT NOT NULL,
    reset_token TEXT,
    is_used INTEGER DEFAULT 0,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 15b. AUDIT LOGS
-- Append-only trail for sensitive actions (employee lifecycle, document and
-- payroll changes, logins). Rows are never updated or deleted by app code.
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    actor_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id TEXT,
    details JSONB DEFAULT '{}',
    ip_address VARCHAR(64),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);

-- 15c. ATTENDANCE REGULARIZATION
-- Employees request corrections for missed/incorrect check-in or check-out.
-- On approval the values are written back into the attendance table.
CREATE TABLE IF NOT EXISTS attendance_regularizations (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    check_in TIME,
    check_out TIME,
    reason TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    reviewed_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    review_note TEXT,
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (employee_id, date)
);
CREATE INDEX IF NOT EXISTS idx_att_reg_employee ON attendance_regularizations (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_reg_status ON attendance_regularizations (status);

-- 16. COMPANY SETTINGS
CREATE TABLE IF NOT EXISTS company_settings (
    id SERIAL PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT,
    description TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 17. ATTENDANCE PHOTOS (one-time view)
CREATE TABLE IF NOT EXISTS attendance_photos (
    id SERIAL PRIMARY KEY,
    attendance_id INT NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
    employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    photo BYTEA NOT NULL,
    token TEXT NOT NULL UNIQUE,
    viewed INTEGER DEFAULT 0,
    viewed_at TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    type VARCHAR(20) DEFAULT 'check_in' CHECK (type IN ('check_in', 'check_out')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 18. PROFILE UPDATE REQUESTS
CREATE TABLE IF NOT EXISTS profile_update_requests (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    reviewed_by INT REFERENCES employees(id) ON DELETE SET NULL,
    review_remarks TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 19. PUSH SUBSCRIPTIONS (PWA web-push)
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    subscription JSONB NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email);
CREATE INDEX IF NOT EXISTS idx_employees_employee_id ON employees(employee_id);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_role ON employees(role);
CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_leave_applications_employee ON leave_applications(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_applications_status ON leave_applications(status);
CREATE INDEX IF NOT EXISTS idx_wfh_requests_employee ON wfh_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_employee ON payroll(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_month_year ON payroll(month, year);
CREATE INDEX IF NOT EXISTS idx_documents_employee ON documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active);
CREATE INDEX IF NOT EXISTS idx_attendance_photos_token ON attendance_photos(token);
CREATE INDEX IF NOT EXISTS idx_attendance_photos_expires ON attendance_photos(expires_at);
CREATE INDEX IF NOT EXISTS idx_profile_requests_employee ON profile_update_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_profile_requests_status ON profile_update_requests(status);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_employee ON announcement_reads(employee_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_employee ON push_subscriptions(employee_id);

-- ============================================
-- SEED DATA
-- ============================================

-- Company branding used on the payslip header (name + address).
INSERT INTO companies (name, address, phone, email, website) VALUES
('G Architects', 'Plot no. 84, Flat no. 302, Sri Nikethan, near Balaji Temple, Siddhi Vinayak Nagar, Balaji Hills, Khanammet, Hyderabad – 500081, Telangana, India', '+91 63740 48059', 'garchitects99@gmail.com', 'www.garchitects.in')
ON CONFLICT (email) DO NOTHING;

INSERT INTO leave_types (name, days_per_year, description, gender_eligibility) VALUES
('Sick or Casual', 12, 'For medical or casual reasons (1 paid day per month, rest LOP)', 'all'),
('Maternity Leave', 0, 'Special leave for female employees during pregnancy (no balance deduction)', 'female'),
('Paternity Leave', 0, 'For male employees after childbirth', 'male'),
('Unpaid Leave', 0, 'Leave without pay', 'all')
ON CONFLICT (name) DO NOTHING;

INSERT INTO company_settings (setting_key, setting_value, description) VALUES
('company_name', 'G Architects', 'Company name'),
('office_start_time', '09:00', 'Office start time'),
('office_end_time', '19:00', 'Office end time'),
('late_grace_period', '15', 'Grace period in minutes'),
('currency', 'INR', 'Default currency'),
('timezone', 'Asia/Kolkata', 'Default timezone')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO departments (name, description) VALUES
('Engineering', 'Software development and technical teams'),
('Human Resources', 'HR and people operations'),
('Marketing', 'Marketing and brand management'),
('Finance', 'Finance and accounting'),
('Operations', 'Business operations')
ON CONFLICT (name) DO NOTHING;

INSERT INTO designations (name, level, department_id) VALUES
('Software Engineer', 1, 1),
('Senior Software Engineer', 2, 1),
('Tech Lead', 3, 1),
('HR Manager', 2, 2),
('HR Executive', 1, 2),
('Marketing Manager', 2, 3),
('Accountant', 1, 4)
ON CONFLICT (name) DO NOTHING;

-- SECURITY: no employee accounts are seeded here. The first admin account is
-- created by scripts/init-db.js with a randomly generated password that is
-- printed once and flagged must_change_password = 1.

INSERT INTO holidays (name, date, description) VALUES
('Republic Day', '2026-01-26', 'National holiday'),
('Holi', '2026-03-10', 'Festival of colors'),
('May Day', '2026-05-01', 'International Workers Day'),
('Independence Day', '2026-08-15', 'National holiday'),
('Gandhi Jayanti', '2026-10-02', 'National holiday'),
('Diwali', '2026-10-20', 'Festival of lights'),
('Christmas', '2026-12-25', 'Christmas Day')
ON CONFLICT (name, date) DO NOTHING;

INSERT INTO announcements (title, content, priority, posted_by, target_audience)
SELECT v.title, v.content, v.priority,
       (SELECT id FROM employees WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1),
       v.target_audience
FROM (VALUES
    ('Welcome to G-Architects HRMS', 'We are excited to announce the launch of our new Human Resource Management System. Please explore the features and provide your feedback.', 'high', 'all'),
    ('Office Timings Update', 'Effective immediately, office timings are 9:00 AM to 7:00 PM with a 15-minute grace period.', 'normal', 'all'),
    ('Team Building Event', 'Join us for a team building event this Friday at 4:00 PM in the conference room.', 'low', 'all')
) AS v(title, content, priority, target_audience)
WHERE NOT EXISTS (SELECT 1 FROM announcements);

-- ============================================
-- MIGRATIONS (idempotent - safe to re-run)
-- ============================================

ALTER TABLE employees ADD COLUMN IF NOT EXISTS reporting_manager_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS reporting_manager_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE wfh_requests ADD COLUMN IF NOT EXISTS reporting_manager_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reporting_manager_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE designations ADD COLUMN IF NOT EXISTS team_lead_id INT REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_employees_reporting_manager ON employees(reporting_manager_id);
CREATE INDEX IF NOT EXISTS idx_leave_rm ON leave_applications(reporting_manager_id);
CREATE INDEX IF NOT EXISTS idx_wfh_rm ON wfh_requests(reporting_manager_id);
CREATE INDEX IF NOT EXISTS idx_tickets_rm ON support_tickets(reporting_manager_id);

-- Token revocation: bumped on password change/reset so all previously issued
-- JWTs become invalid immediately (verifyToken compares token_version).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Maternity Leave is a special leave: 0 days balance, no deduction, still approvable.
UPDATE leave_types SET days_per_year = 0 WHERE name = 'Maternity Leave';

-- Paternity Leave: 0 days balance, no deduction, still approvable (like Maternity).
UPDATE leave_types SET days_per_year = 0 WHERE name = 'Paternity Leave';

-- Earned Leave removed from new requests (soft-disable) - history is preserved.
UPDATE leave_types SET is_active = 0 WHERE name = 'Earned Leave';

-- Sick or Casual: 12 days/year, 1 paid per month, rest LOP.
UPDATE leave_types SET days_per_year = 12, is_active = 1 WHERE name = 'Sick or Casual';
UPDATE leave_types SET is_active = 0 WHERE name = 'Sick Leave';
UPDATE leave_types SET is_active = 0
WHERE name IN ('Maternity Leave', 'Paternity Leave', 'Unpaid Leave', 'Earned Leave');

-- Add May Day holiday for 2026 (idempotent).
INSERT INTO holidays (name, date, description)
SELECT 'May Day', '2026-05-01', 'International Workers Day'
WHERE NOT EXISTS (SELECT 1 FROM holidays WHERE name = 'May Day' AND date = '2026-05-01');

-- Add team_lead role (idempotent: drop + recreate the role check constraint).
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_role_check CHECK (role IN ('admin', 'hr', 'manager', 'team_lead', 'employee'));

-- Multi-approver: manager_id and hr_id on request tables (idempotent).
ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS hr_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE wfh_requests ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE wfh_requests ADD COLUMN IF NOT EXISTS hr_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS hr_id INT REFERENCES employees(id) ON DELETE SET NULL;

-- ============================================
-- SALARY STRUCTURE ON EMPLOYEES
-- Mirrors the payroll columns so payslips can be auto-filled from the
-- employee's stored salary components when generating payroll.
-- Admin sets these when adding/editing an employee; the employee can
-- view them on their profile. Only Present/Leave/LOP days are entered
-- at payroll time - everything else is auto-calculated from this.
-- ============================================

ALTER TABLE employees ADD COLUMN IF NOT EXISTS basic_salary DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hra DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS conveyance DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS medical DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS special_allowance DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS other_allowance DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pf DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS esi DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS professional_tax DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS income_tax DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS loan_deduction DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS advance_salary DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS other_deduction DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS incentive DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bonus DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS extra_work DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employer_pf DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employer_esi DECIMAL(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employer_contribution DECIMAL(10,2) DEFAULT 0;

-- Backfill basic_salary from the legacy gross salary column where empty.
UPDATE employees SET basic_salary = salary
WHERE (basic_salary IS NULL OR basic_salary = 0) AND salary IS NOT NULL AND salary > 0;

-- Fill the payslip header company address for existing rows (idempotent).
UPDATE companies SET address = 'Plot no. 84, Flat no. 302, Sri Nikethan, near Balaji Temple, Siddhi Vinayak Nagar, Balaji Hills, Khanammet, Hyderabad – 500081, Telangana, India'
WHERE address IS NULL OR address = '';

-- ============================================
-- PAYROLL MODULE MIGRATIONS (idempotent)
-- ============================================

-- Employee master: statutory / compliance identifiers shown on the payslip.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS uan_number TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pf_number TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS esi_number TEXT;

-- Payroll: attendance summary for the pay period.
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS working_days INT DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS present_days INT DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS leave_days INT DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS lop_days INT DEFAULT 0;

-- Payroll: granular earnings (kept separate from the legacy `allowances` column).
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS hra DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS conveyance DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS medical DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS special_allowance DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS bonus DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS incentive DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS extra_work DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS other_allowance DECIMAL(10,2) DEFAULT 0;

-- Payroll: employee deductions (kept separate from the legacy `deductions` column).
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS pf DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS esi DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS professional_tax DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS income_tax DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS loan_deduction DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS advance_salary DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS other_deduction DECIMAL(10,2) DEFAULT 0;

-- Payroll: employer contributions.
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS employer_pf DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS employer_esi DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS employer_contribution DECIMAL(10,2) DEFAULT 0;

-- Payroll: computed values (stored for fast reporting / history).
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS gross_salary DECIMAL(10,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS total_deductions DECIMAL(10,2) DEFAULT 0;

-- Payroll: guarantee the (employee_id, month, year) uniqueness that the
-- generate/generate-bulk upserts rely on with ON CONFLICT. Databases created
-- before the UNIQUE table constraint existed get it via this idempotent index.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_employee_month_year_uidx ON payroll (employee_id, month, year);

CREATE INDEX IF NOT EXISTS idx_payroll_status ON payroll(status);

-- ============================================
-- ONBOARDING MODULE MIGRATIONS (idempotent)
-- ============================================

-- Checklist templates managed by the admin. When a new employee profile is
-- created, every active template is copied into that employee's onboarding
-- process as a pending task. Default templates are seeded below and the
-- onboarding service also self-seeds an empty table so databases that were
-- only migrated (db:migrate skips INSERTs) never end up with zero templates.
CREATE TABLE IF NOT EXISTS hr_task_templates (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    assignee_role VARCHAR(20) NOT NULL DEFAULT 'employee' CHECK (assignee_role IN ('admin', 'employee')),
    sequence INT DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hr_task_templates_active ON hr_task_templates(is_active);

-- One onboarding journey per employee (type kept for a future offboarding flow).
CREATE TABLE IF NOT EXISTS employee_processes (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL DEFAULT 'onboarding' CHECK (type IN ('onboarding', 'offboarding')),
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
    started_by INT REFERENCES employees(id) ON DELETE SET NULL,
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    UNIQUE (employee_id, type)
);
CREATE INDEX IF NOT EXISTS idx_employee_processes_employee ON employee_processes(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_processes_status ON employee_processes(status);

-- Per-employee checklist items copied from the active templates at start time
-- (copied so later template edits never rewrite an existing journey's history).
CREATE TABLE IF NOT EXISTS process_tasks (
    id SERIAL PRIMARY KEY,
    process_id INT NOT NULL REFERENCES employee_processes(id) ON DELETE CASCADE,
    template_id INT REFERENCES hr_task_templates(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    assignee_role VARCHAR(20) NOT NULL DEFAULT 'employee' CHECK (assignee_role IN ('admin', 'employee')),
    sequence INT DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
    remarks TEXT,
    completed_by INT REFERENCES employees(id) ON DELETE SET NULL,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_process_tasks_process ON process_tasks(process_id);

-- Default onboarding checklist (idempotent). The onboarding service re-seeds
-- an empty table at runtime as well, so this only matters for fresh installs.
INSERT INTO hr_task_templates (title, description, assignee_role, sequence)
SELECT v.title, v.description, v.assignee_role, v.sequence
FROM (VALUES
    ('Complete your profile details', 'Log in and fill your personal, contact and identification details under My Profile.', 'employee', 1),
    ('Submit bank & statutory details', 'Add bank account, PAN, Aadhaar and UAN/PF/ESI numbers in My Profile for payroll processing.', 'employee', 2),
    ('Collect laptop, ID card & access badge', 'Hand over the company laptop, ID card and building access to the new joiner.', 'admin', 3),
    ('Create office email & tool access', 'Set up the office email account and grant access to the tools the employee needs.', 'admin', 4),
    ('Meet reporting manager & team introduction', 'Introductory meeting with the reporting manager and the team.', 'employee', 5),
    ('Acknowledge company policies', 'Read and acknowledge the HR, attendance and leave policies.', 'employee', 6)
) AS v(title, description, assignee_role, sequence)
WHERE NOT EXISTS (SELECT 1 FROM hr_task_templates);

-- Attendance: allow 'wfh' status (idempotent migration for existing DBs)
DO $$ BEGIN
    ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE attendance ADD CONSTRAINT attendance_status_check CHECK (status IN ('present', 'absent', 'half-day', 'late', 'holiday', 'weekoff', 'wfh'));

-- Announcements: auto-expiry column (Asia/Kolkata timezone, admin sets via datetime-local)
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_announcements_expires_at ON announcements(expires_at);

-- ============================================================
-- 20. PROJECTS
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    customer VARCHAR(255),
    client VARCHAR(255),
    description TEXT,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'paused', 'terminated', 'on_hold', 'completed', 'cancelled')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 21. PROJECT EMPLOYEES
-- ============================================================
CREATE TABLE IF NOT EXISTS project_employees (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES projects(id) ON DELETE CASCADE,
    employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'active',
    UNIQUE(project_id, employee_id)
);

-- ============================================================
-- 22. PROJECT SETS / BATCHES
-- ============================================================
CREATE TABLE IF NOT EXISTS project_sets (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    total_target INT NOT NULL DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 23. DAILY WORK COUNTS
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_work_counts (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES projects(id) ON DELETE CASCADE,
    set_id INT REFERENCES project_sets(id) ON DELETE CASCADE,
    employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    work_date DATE NOT NULL,
    daily_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(project_id, set_id, employee_id, work_date)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_project_employees_project ON project_employees(project_id);
CREATE INDEX IF NOT EXISTS idx_project_employees_employee ON project_employees(employee_id);
CREATE INDEX IF NOT EXISTS idx_project_sets_project ON project_sets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_sets_status ON project_sets(status);
CREATE INDEX IF NOT EXISTS idx_daily_work_counts_project ON daily_work_counts(project_id);
CREATE INDEX IF NOT EXISTS idx_daily_work_counts_set ON daily_work_counts(set_id);
CREATE INDEX IF NOT EXISTS idx_daily_work_counts_employee ON daily_work_counts(employee_id);
CREATE INDEX IF NOT EXISTS idx_daily_work_counts_date ON daily_work_counts(work_date);
CREATE INDEX IF NOT EXISTS idx_daily_work_counts_unique ON daily_work_counts(project_id, set_id, employee_id, work_date);

-- ============================================================
-- 24. PROJECT SETTINGS (for holiday config, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS project_settings (
    id SERIAL PRIMARY KEY,
    project_id INT REFERENCES projects(id) ON DELETE CASCADE,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    description TEXT,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(project_id, setting_key)
);

-- ============================================================
-- SEED DATA for projects (optional - admin can add later)
-- ============================================================

-- Default project entries can be added via admin UI
INSERT INTO projects (name, customer, description, status) VALUES
('Travel Management', 'US', 'Travel management system', 'active'),
('Medical Billing', 'US', 'Medical billing processing', 'active'),
('KYC', 'US', 'Know Your Customer verification', 'active')
ON CONFLICT (name) DO NOTHING;

-- Default project employee assignments (idempotent - only adds if not exist)
INSERT INTO project_employees (project_id, employee_id)
SELECT p.id, e.id FROM projects p, employees e
WHERE p.name = 'Travel Management' AND e.role != 'admin'
ON CONFLICT (project_id, employee_id) DO NOTHING;

INSERT INTO project_employees (project_id, employee_id)
SELECT p.id, e.id FROM projects p, employees e
WHERE p.name = 'Medical Billing' AND e.role != 'admin'
ON CONFLICT (project_id, employee_id) DO NOTHING;

INSERT INTO project_employees (project_id, employee_id)
SELECT p.id, e.id FROM projects p, employees e
WHERE p.name = 'KYC' AND e.role != 'admin'
ON CONFLICT (project_id, employee_id) DO NOTHING;

-- Default project sets with automatic target calculations
-- Set 1 for Travel Management: 1000 files, 2 working days, 5 employees
INSERT INTO project_sets (project_id, name, start_date, end_date, total_target)
SELECT p.id, 'Batch_1', '2026-09-03', '2026-09-04', 1000
FROM projects p WHERE p.name = 'Travel Management'
ON CONFLICT DO NOTHING;

-- Set 2 for Travel Management: 1500 files, 3 working days, 5 employees
INSERT INTO project_sets (project_id, name, start_date, end_date, total_target)
SELECT p.id, 'Batch_2', '2026-09-05', '2026-09-07', 1500
FROM projects p WHERE p.name = 'Travel Management'
ON CONFLICT DO NOTHING;

-- Set 1 for Medical Billing: 800 files, 2 working days, 3 employees
INSERT INTO project_sets (project_id, name, start_date, end_date, total_target)
SELECT p.id, 'Batch_1', '2026-09-03', '2026-09-04', 800
FROM projects p WHERE p.name = 'Medical Billing'
ON CONFLICT DO NOTHING;

-- Set 1 for KYC: 500 files, 1 working day, 2 employees
INSERT INTO project_sets (project_id, name, start_date, end_date, total_target)
SELECT p.id, 'Batch_1', '2026-09-03', '2026-09-03', 500
FROM projects p WHERE p.name = 'KYC'
ON CONFLICT DO NOTHING;
