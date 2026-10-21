const API_URL = '/api';

function getLoginUrl(user) {
    // Never bounce a signed-out user at a guarded page (redirect-loop guard).
    if (!localStorage.getItem('token')) return '/';
    if (user && user.role === 'manager') return '/manager/my-team';
    if (user && ['admin', 'hr'].includes(user.role)) return '/admin/';
    return '/';
}

// Login-page detection must match ONLY the actual login surfaces.
// Never use startsWith('/admin') here - every admin portal page lives
// under /admin/<page> now, and matching those caused an infinite
// redirect loop between the page and itself after the clean-URL change.
document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    const path = window.location.pathname;
    const onLoginPage =
        path === '/' || path === '' ||
        path === '/login' ||
        path === '/admin' || path === '/admin/' ||
        path.includes('login.html'); // legacy /pages/*.html paths
    if (token && onLoginPage) {
        const user = getCurrentUser();
        if (!user) return;
        if (user.role === 'admin' || user.role === 'hr') {
            window.location.href = '/admin/dashboard';
        } else if (user.role === 'manager') {
            window.location.href = '/manager/my-team';
        } else {
            window.location.href = '/employee/dashboard';
        }
    }
});

// Toggle password visibility
function togglePassword() {
    const passwordInput = document.getElementById('password');
    const eyeIcon = document.getElementById('eyeIcon');
    
    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        eyeIcon.classList.remove('fa-eye');
        eyeIcon.classList.add('fa-eye-slash');
    } else {
        passwordInput.type = 'password';
        eyeIcon.classList.remove('fa-eye-slash');
        eyeIcon.classList.add('fa-eye');
    }
}

// Handle Login
async function handleLogin(event, portal) {
    event.preventDefault();
    
    const employee_id = document.getElementById('employeeId').value.trim();
    const password = document.getElementById('password').value;
    const submitBtn = event.target.querySelector('button[type="submit"]');
    
    if (!employee_id || !password) {
        showToast('Please enter Employee ID and password', 'error');
        return;
    }
    
    const originalContent = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Logging in...';
    submitBtn.disabled = true;
    
    try {
        const response = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_id, password, portal: portal || 'employee' })
        });
        
        const data = await response.json();
        
        if (data.success) {
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            requestPushPermission();
            
            submitBtn.innerHTML = '<i class="fas fa-check"></i> Success!';
            submitBtn.style.background = 'var(--success)';
            
            showToast('Login successful! Redirecting...', 'success');
            
            setTimeout(() => {
                if (data.must_change_password && data.user.role !== 'admin') {
                    window.location.href = '/employee/profile';
                } else if (data.user.role === 'admin' || data.user.role === 'hr') {
                    window.location.href = '/admin/dashboard';
                } else if (data.user.role === 'manager') {
                    window.location.href = '/manager/my-team';
                } else {
                    window.location.href = '/employee/dashboard';
                }
            }, 800);
        } else {
            showToast(data.message || 'Invalid credentials', 'error');
            submitBtn.innerHTML = originalContent;
            submitBtn.disabled = false;
            submitBtn.style.background = '';
            
            const passwordField = document.getElementById('password');
            passwordField.style.borderColor = 'var(--danger)';
            setTimeout(() => { passwordField.style.borderColor = ''; }, 2000);
        }
    } catch (error) {
        console.error('Login error:', error);
        showToast('Network error. Please try again.', 'error');
        submitBtn.innerHTML = originalContent;
        submitBtn.disabled = false;
        submitBtn.style.background = '';
    }
}

// Toast notification
function showToast(message, type = 'success') {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icons = {
        success: 'check-circle',
        error: 'exclamation-circle',
        warning: 'exclamation-triangle',
        info: 'info-circle'
    };
    
    toast.innerHTML = `
        <i class="fas fa-${icons[type] || 'info-circle'}"></i>
        <span></span>
    `;
    toast.querySelector('span').textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'toastSlideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// API helper function
async function apiCall(endpoint, method = 'GET', body = null, opts = null) {
    const { timeoutMs, silent } = opts || {};
    const token = localStorage.getItem('token');
    const headers = { 'Content-Type': 'application/json' };
    
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    
    const options = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }
    // Default timeout (MI-7): every apiCall aborts after 20s unless the
    // caller passes an explicit opts.timeoutMs, so a hung socket (e.g. a
    // cold Vercel instance) falls into the catch/error path below instead
    // of leaving the caller's loader spinning forever. JSON endpoints only
    // go through here - downloads/PDFs use downloadWithAuth/fetch.
    const effectiveTimeoutMs = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 20000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), effectiveTimeoutMs);
    options.signal = ctrl.signal;

    try {
        const response = await fetch(`${API_URL}${endpoint}`, options);
        
        if (response.status === 401) {
            const user = getCurrentUser();
            const loginUrl = getLoginUrl(user);
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = loginUrl;
            return null;
        }
        
        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            data = null;
        }
        
        if (!data) {
            return { success: false, message: 'Server error. Please try again.' };
        }
        
        // Surface the server's error message to the caller instead of a generic one.
        if (!response.ok && !data.success) {
            return data;
        }
        
        return data;
    } catch (error) {
        if (!silent) {
            console.error('API Error:', error);
            showToast('Network error. Please try again.', 'error');
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Logout function
async function logout() {
    const token = localStorage.getItem('token');
    const user = getCurrentUser();
    // Managers land on the manager portal - logging out back at it would bounce
    // them again, so send managers straight to the login surface.
    const loginUrl = (user && user.role === 'manager') ? '/' : getLoginUrl(user);
    try {
        if (token) await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    } catch(e) {}
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = loginUrl;
}

// Download a file (PDF/Excel) with the auth token attached.
// successMsg (optional) overrides the default completion toast.
async function downloadWithAuth(endpoint, filename, successMsg) {
    const token = localStorage.getItem('token');
    if (!token) { window.location.href = getLoginUrl(getCurrentUser()); return; }
    try {
        const response = await fetch(`${API_URL}${endpoint}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.status === 401) {
            const user = getCurrentUser();
            const loginUrl = getLoginUrl(user);
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = loginUrl;
            return;
        }
        if (!response.ok) {
            let msg = 'Failed to download';
            try {
                const j = await response.json();
                if (j && j.message) msg = j.message;
            } catch (e) { /* non-JSON error body */ }
            showToast(msg, 'error');
            return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast(successMsg || ('Downloaded: ' + (filename || 'file')), 'success');
    } catch (error) {
        showToast('Network error while downloading', 'error');
    }
}

// Download a payslip PDF by payslip id
function downloadPayslipPdf(id) {
    const payload = String(id).split('|');
    const payslipId = payload[0];
    const name = payload[1] || 'payslip';
    downloadWithAuth(`/payroll/${payslipId}/pdf`, `payslip_${name}_${payslipId}.pdf`);
}

// Get current user
function getCurrentUser() {
    try {
        const user = localStorage.getItem('user');
        return user ? JSON.parse(user) : null;
    } catch (e) {
        localStorage.removeItem('user');
        return null;
    }
}

// Check authentication
function checkAuth() {
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = getLoginUrl(getCurrentUser());
        return false;
    }
    return true;
}

// Admin-only guard for admin pages. Redirects non-admin users to the employee portal.
function requireAdmin() {
    if (!checkAuth()) return false;
    const user = getCurrentUser();
    if (!user || !['admin', 'hr', 'manager'].includes(user.role)) {
        window.location.href = '/employee/dashboard';
        return false;
    }
    return true;
}

// Get initials from name
function getInitials(firstName, lastName) {
    return ((firstName?.[0] || '') + (lastName?.[0] || '')).toUpperCase();
}

// Format currency
function formatCurrency(amount) {
    return '₹' + Number(amount || 0).toLocaleString('en-IN');
}

// Format date
function formatDate(dateString, options = {}) {
    if (!dateString) return '';
    const raw = String(dateString);
    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    let d;
    if (dateOnly) {
        // Date-only keys carry no timezone: new Date('YYYY-MM-DD') parses
        // them at UTC midnight, so toLocaleDateString renders the PREVIOUS
        // day in browsers west of UTC. Build the calendar day locally at
        // noon instead - the rendered day is then the key's day in every
        // browser timezone (MI-5). Output format is unchanged.
        d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12, 0, 0);
        if (d.getFullYear() !== Number(dateOnly[1]) || d.getMonth() !== Number(dateOnly[2]) - 1 || d.getDate() !== Number(dateOnly[3])) return '';
    } else {
        d = new Date(raw);
    }
    if (isNaN(d.getTime())) return '';
    const defaults = { year: 'numeric', month: 'short', day: 'numeric' };
    return d.toLocaleDateString('en-IN', { ...defaults, ...options });
}

// Today's date in IST as YYYY-MM-DD. Never use toISOString().split('T')[0]
// for "today" checks - that is UTC and returns yesterday between 00:00 and
// 05:29 IST.
function getTodayIST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Escape HTML for both text and attribute contexts.
// div.textContent/div.innerHTML escapes &, <, > and (in browsers) " and ',
// but relying on the browser mapping is fragile, so we also escape quotes
// and '/' explicitly for safe use inside single/double-quoted attributes.
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Load saved theme
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        // Sync the header toggle icon with the restored theme.
        const icon = document.getElementById('themeIcon');
        if (icon) { icon.classList.remove('fa-moon'); icon.classList.add('fa-sun'); }
    }
});

// Show My Team link on every employee page for TL/manager/HR (previously only directory.html did this).
document.addEventListener('DOMContentLoaded', () => {
    try {
        const u = getCurrentUser();
        if (u && (u.role === 'manager' || u.role === 'team_lead' || u.role === 'hr')) {
            const link = document.getElementById('myTeamLink');
            if (link) link.style.display = 'flex';
        }
        // Team Work link: managers/TL/HR plus admin (full assignment overview).
        if (u && (u.role === 'admin' || u.role === 'manager' || u.role === 'team_lead' || u.role === 'hr')) {
            const link = document.getElementById('teamWorkLink');
            if (link) link.style.display = 'flex';
        }
        // Team Projects link: same roles — assign employees into projects/units.
        if (u && (u.role === 'admin' || u.role === 'manager' || u.role === 'team_lead' || u.role === 'hr')) {
            const link = document.getElementById('teamProjectsLink');
            if (link) link.style.display = 'flex';
        }
        // My Led Projects link: same roles — a designated lead places their team.
        if (u && (u.role === 'admin' || u.role === 'manager' || u.role === 'team_lead' || u.role === 'hr')) {
            const link = document.getElementById('ledProjectsLink');
            if (link) link.style.display = 'flex';
        }
    } catch (e) {}
});

// ---- Phase C: role-aware portal navigation ----
// The API layer is the hard security boundary; this filter only stops a role
// from seeing/clicking pages whose APIs would 403 for it.
//   manager → admin portal items are all staff/analytics-driven, so they are
//             hidden (the manager portal is their home).
//   hr      → hides the admin-only items: project CRUD, audit logs, settings.
function applyRoleNav() {
    try {
        const user = getCurrentUser();
        if (!user) return;
        const hide = new Set();
        if (user.role === 'manager') {
            ['/admin/dashboard','/admin/employees','/admin/departments','/admin/designations',
             '/admin/onboarding','/admin/attendance','/admin/leave','/admin/wfh','/admin/payroll',
             '/admin/project-management','/admin/tickets','/admin/documents','/admin/reports',
             '/admin/audit-logs','/admin/settings'].forEach(p => hide.add(p));
        } else if (user.role === 'hr') {
            ['/admin/project-management','/admin/audit-logs','/admin/settings'].forEach(p => hide.add(p));
        }
        if (hide.size === 0) return;
        const sidebar = document.querySelector('#sidebar');
        if (!sidebar) return;
        sidebar.querySelectorAll('.sidebar-nav a.nav-item').forEach(a => {
            if (hide.has(a.getAttribute('href'))) a.style.display = 'none';
        });
        // Collapse any section title whose child links all got hidden.
        sidebar.querySelectorAll('.sidebar-nav .nav-section-title').forEach(title => {
            let next = title.nextElementSibling;
            let allHidden = true;
            while (next && !next.classList.contains('nav-section-title')) {
                if (next.tagName === 'A' && next.style.display !== 'none') { allHidden = false; break; }
                next = next.nextElementSibling;
            }
            if (allHidden) title.style.display = 'none';
        });
    } catch (e) { /* navbar filtering is cosmetic only */ }
}
document.addEventListener('DOMContentLoaded', applyRoleNav);

// The three /manager/* pages (Team Work, Team Projects, My Led Projects) are
// linked from the ADMIN sidebar, but they render the EMPLOYEE sidebar - whose
// every link points back into /employee/* and none point into /admin/*. Since
// employee pages only call checkAuth() (a valid admin token passes), an admin
// who clicked one of those links silently got stranded in the employee portal
// with no way back except retyping the URL or logging in again. Surface an
// explicit "Admin Portal" entry at the top of that sidebar for admin/hr so the
// return path always exists. Managers/TLs never see it - the manager portal is
// their home.
function applyManagerPortalAdminLink() {
    try {
        const user = getCurrentUser();
        if (!user || !['admin', 'hr'].includes(user.role)) return;
        if (!/^\/manager(\/|$)/.test(location.pathname)) return;
        const nav = document.querySelector('#sidebar .sidebar-nav');
        if (!nav || nav.querySelector('[data-portal-back="admin"]')) return;
        // This /manager/* page renders the EMPLOYEE sidebar, which already has a
        // "Dashboard" link pointing at /employee/dashboard. For an admin/hr that
        // is a second, wrong dashboard (this page belongs to the manager portal),
        // so it showed up as TWO dashboard entries next to the "Admin Portal"
        // link below. Hide it so exactly one dashboard entry remains.
        nav.querySelectorAll('a.nav-item').forEach(a => {
            if (a.getAttribute('href') === '/employee/dashboard') a.style.display = 'none';
        });
        const link = document.createElement('a');
        link.href = '/admin/dashboard';
        link.setAttribute('data-portal-back', 'admin');
        link.className = 'nav-item';
        link.innerHTML = '<i class="fas fa-shield-halved"></i><span class="nav-text">Admin Portal</span>';
        nav.insertBefore(link, nav.firstChild);
    } catch (e) { /* navigation aid is cosmetic only */ }
}
document.addEventListener('DOMContentLoaded', applyManagerPortalAdminLink);

// The admin account is the "super admin": a monitoring / full-access role that
// is NOT an employee. The /employee/* pages are the employee self-service
// surface (check-in/out, leave, WFH, regularization, payslips, onboarding,
// profile change requests) and do not apply to an admin. If an admin reaches
// one - typed URL, stale link, or via a /manager/* oversight page whose sidebar
// points back into /employee/* - bounce them to the admin portal instead of
// showing widgets the server will reject anyway. On the /manager/* oversight
// pages, also hide the employee self-service sidebar links so only oversight
// links remain.
function applySuperAdminSelfServiceGuard() {
    try {
        const user = getCurrentUser();
        if (!user || user.role !== 'admin') return;
        if (/^\/employee(\/|$)/.test(location.pathname)) {
            location.replace('/admin/dashboard');
            return;
        }
        if (!/^\/manager(\/|$)/.test(location.pathname)) return;
        const nav = document.querySelector('#sidebar .sidebar-nav');
        if (!nav) return;
        nav.querySelectorAll('a.nav-item').forEach(a => {
            const href = a.getAttribute('href') || '';
            if (href === '/employee/dashboard' || href.startsWith('/employee/')) a.style.display = 'none';
        });
        // Collapse any section title whose child links all got hidden.
        nav.querySelectorAll('.nav-section-title').forEach(title => {
            let next = title.nextElementSibling;
            let allHidden = true;
            while (next && !next.classList.contains('nav-section-title')) {
                if (next.tagName === 'A' && next.style.display !== 'none') { allHidden = false; break; }
                next = next.nextElementSibling;
            }
            if (allHidden) title.style.display = 'none';
        });
    } catch (e) { /* navigation guard is cosmetic only */ }
}
document.addEventListener('DOMContentLoaded', applySuperAdminSelfServiceGuard);

// The admin portal has no profile page of its own - an admin's only view of
// their own details was the read-only card buried inside /admin/settings, so
// it was effectively undiscoverable. Inject a "My Profile" entry into the
// header dropdown on every /admin/* page (markup is identical across them, so
// doing it here beats 18 near-duplicate HTML edits). It anchors to the profile
// card, which is now editable.
function applyAdminProfileMenuLink() {
    try {
        const user = getCurrentUser();
        if (!user || !['admin', 'hr'].includes(user.role)) return;
        if (!/^\/admin(\/|$)/.test(location.pathname)) return;
        const menu = document.getElementById('profileMenu');
        if (!menu || menu.querySelector('[data-portal-profile="admin"]')) return;
        const link = document.createElement('a');
        link.href = '/admin/settings#profile';
        link.className = 'profile-menu-item';
        link.setAttribute('data-portal-profile', 'admin');
        link.innerHTML = '<i class="fas fa-user"></i> My Profile';
        menu.insertBefore(link, menu.firstChild);
    } catch (e) { /* navigation aid is cosmetic only */ }
}
document.addEventListener('DOMContentLoaded', applyAdminProfileMenuLink);

// ==================== PWA SUPPORT ====================

const PWA_CAN_REGISTER = 'serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

// Register the service worker once on first load.
if (PWA_CAN_REGISTER) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then((reg) => {
            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                if (!newWorker) return;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        showToast('New version available. Refreshing...', 'info');
                        newWorker.postMessage({ type: 'SKIP_WAITING' });
                        setTimeout(() => window.location.reload(), 1200);
                    }
                });
            });
        }).catch(() => {});
    });

    // Re-validate the service worker whenever the app becomes visible again.
    // Resumed PWA windows (tapped from the home screen) often restore a session
    // WITHOUT a network navigation, so the browser's update check is skipped and
    // a fresh deploy would wait until the next full reload - which makes users
    // think they must reinstall to get updates. reg.update() forces the browser
    // to re-fetch sw.js (served with no-cache) right away; the updatefound
    // handler above then auto-refreshes the page.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            navigator.serviceWorker.ready
                .then((reg) => reg.update())
                .catch(() => {});
        }
    });
}

// Offline / online toasts
window.addEventListener('offline', () => {
    showToast('You are offline - showing cached app', 'warning');
});
window.addEventListener('online', () => {
    showToast('Back online', 'success');
});

// ---------- Install (A2HS) prompt ----------
let deferredInstallPrompt = null;
let installBtnEl = null;

// Only surface the floating install button on the login screens.
function isLoginPage() {
    const p = location.pathname;
    return p === '/' || p === '/login' || p === '/admin' || p === '/admin/' ||
        /\/pages\/login\.html$/.test(p) || /\/pages\/admin-login\.html$/.test(p);
}

function ensureInstallButton() {
    if (installBtnEl || !deferredInstallPrompt) return;
    if (!isLoginPage()) return;
    installBtnEl = document.createElement('button');
    installBtnEl.id = 'pwaInstallBtn';
    installBtnEl.innerHTML = '<i class="fas fa-download"></i> Install App';
    installBtnEl.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:#4F46E5;color:#fff;border:none;border-radius:50px;padding:12px 18px;font-size:0.9rem;font-weight:600;cursor:pointer;box-shadow:0 8px 20px rgba(79,70,229,0.4);display:flex;align-items:center;gap:8px;';
    installBtnEl.onclick = async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (outcome === 'accepted') hideInstallButton();
    };
    document.body.appendChild(installBtnEl);
}

function hideInstallButton() {
    if (installBtnEl) { installBtnEl.remove(); installBtnEl = null; }
}

if (PWA_CAN_REGISTER) {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        ensureInstallButton();
    });
    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        hideInstallButton();
    });
}

// ---------- Push notifications ----------
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
}

async function pushSubscription() {
    if (!PWA_CAN_REGISTER || !('PushManager' in window)) return;
    const token = localStorage.getItem('token');
    if (!token) return;

    let publicKey = null;
    try {
        const keyRes = await apiCall('/push/vapid-public-key');
        publicKey = keyRes && keyRes.success ? keyRes.publicKey : null;
    } catch (e) { return; }
    if (!publicKey) return; // push not configured

    try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            if (Notification.permission !== 'granted') {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') return;
            }
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            });
        }
        await apiCall('/push/subscribe', 'POST', { subscription: sub.toJSON() });
    } catch (e) {
        console.error('Push subscription error:', e);
    }
}

// Called right after a successful login (user gesture is available for the permission prompt).
function requestPushPermission() {
    pushSubscription();
}

// If the user is already logged in (e.g. reopening the app), keep the subscription in sync.
if (PWA_CAN_REGISTER && localStorage.getItem('token')) {
    document.addEventListener('DOMContentLoaded', () => pushSubscription());
}

// ==================== CONSENT / PRIVACY NOTICES ====================
// Versioned consent records. Every notice is recorded server-side via
// POST /api/consent/record; the client cannot forge user_id, timestamp or method.
// Choice values: granted / declined / withdrawn / acknowledged.
// Mandatory notices (privacy, employee_notice, terms) must be acknowledged.
// Attendance camera/location is required for attendance (mandatory, with manual
// review exception workflow). Push notifications is optional.

const CONSENT_NOTICES = [
    {
        key: 'privacy',
        title: 'Privacy Policy',
        purpose: 'We collect and process your personal data to administer your employment, run payroll, track attendance, and comply with statutory obligations (PAN, Aadhaar, PF/ESI, bank details). Data is stored in India and accessed only by authorized HR/Admin staff.',
        required: true,
        choices: ['acknowledged'],
        defaultChoice: 'acknowledged'
    },
    {
        key: 'employee_notice',
        title: 'Employee Privacy Notice',
        purpose: 'HR-specific notice covering attendance photos/location, manager/HR access to your records, work log monitoring boundaries, retention periods, and your rights to correct data or raise a grievance.',
        required: true,
        choices: ['acknowledged'],
        defaultChoice: 'acknowledged'
    },
    {
        key: 'attendance_camera',
        title: 'Attendance Camera / Selfie',
        purpose: 'A selfie is captured at check-in to verify your identity. The photo is stored in a private bucket for 30 days, viewable only by you, your manager, and HR. It is never used for marketing or shared with third parties. Camera permission is requested only when you tap Check In - never in the background.',
        required: true,
        choices: ['granted', 'declined'],
        defaultChoice: 'granted',
        exceptionText: 'If you cannot provide camera access, a documented manual-review workflow is available: contact HR to record attendance through an alternative method. You will not be denied all attendance recording.'
    },
    {
        key: 'attendance_location',
        title: 'Attendance Location',
        purpose: 'Your location (latitude/longitude) is checked at check-in to confirm you are at the office. Only the coordinate is stored - not a continuous trace. Location permission is requested only when you tap Check In - never in the background.',
        required: true,
        choices: ['granted', 'declined'],
        defaultChoice: 'granted',
        exceptionText: 'If location access is unavailable, contact HR for a manual exception. You will not be denied all attendance recording.'
    },
    {
        key: 'terms_acceptable_use',
        title: 'Terms of Use / Acceptable Use',
        purpose: 'Authorized use of the HRMS, account security, accurate data entry, prohibited misuse, acceptable uploads, and suspension/termination process. Does not override your employment contract or statutory rights.',
        required: true,
        choices: ['acknowledged'],
        defaultChoice: 'acknowledged'
    },
    {
        key: 'push_notifications',
        title: 'Push Notifications',
        purpose: 'Optional. Receive check-in reminders, leave approvals, and announcements via browser push. You can disable this at any time from My Profile.',
        required: false,
        choices: ['granted', 'declined'],
        defaultChoice: 'granted'
    }
];

// Check whether the current user still has pending consent notices.
// Returns the list of notices not yet acknowledged/granted by this user.
async function checkConsentRequired() {
    try {
        const res = await apiCall('/api/consent/mine', 'GET', null, { silent: true });
        if (!res || !res.success) return CONSENT_NOTICES.filter(n => n.required);
        const existing = new Set((res.consent || []).map(c => c.notice_key + ':' + c.choice));
        return CONSENT_NOTICES.filter(n => {
            // Required notices must be acknowledged/granted; declined mandatory = still pending
            if (n.required) {
                const hasGranted = existing.has(n.key + ':granted') || existing.has(n.key + ':acknowledged');
                return !hasGranted;
            }
            // Optional notices: only pending if never recorded
            return !existing.has(n.key + ':granted') && !existing.has(n.key + ':declined');
        });
    } catch (e) {
        return CONSENT_NOTICES.filter(n => n.required);
    }
}

// Build the HTML for the consent modal body.
function buildConsentModalBody(pending) {
    let html = '<div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:16px;">Before you start, please review and accept the following notices. These explain what data we collect, why, and your rights.</div>';
    pending.forEach((notice, idx) => {
        const isRequired = notice.required;
        html += '<div class="consent-notice">';
        html += '<h4>' + (isRequired ? '<i class="fas fa-exclamation-circle" style="color:var(--danger);margin-right:6px;"></i>' : '<i class="fas fa-info-circle" style="color:var(--info);margin-right:6px;"></i>') + escapeHtml(notice.title) + '</h4>';
        html += '<p>' + escapeHtml(notice.purpose) + '</p>';
        if (notice.exceptionText) {
            html += '<div class="attendance-exception"><strong>Exception / manual review:</strong> ' + escapeHtml(notice.exceptionText) + '</div>';
        }
        html += '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">';
        notice.choices.forEach(choice => {
            const checked = choice === notice.defaultChoice ? 'checked' : '';
            const choiceLabel = choice === 'granted' ? 'I agree' : (choice === 'acknowledged' ? 'I acknowledge' : 'I decline');
            html += '<label class="consent-choice">';
            html += '<input type="radio" name="consent_' + notice.key + '" value="' + escapeHtml(choice) + '" ' + checked + '>';
            html += '<span class="consent-choice-label"><strong>' + escapeHtml(choiceLabel) + '</strong>';
            if (isRequired && choice !== 'declined') html += ' <span class="consent-required">required</span>';
            html += '</span>';
            html += '<span class="consent-choice-desc">' + escapeHtml(choice === 'granted' ? 'Allow this processing.' : (choice === 'declined' ? 'Do not allow this processing.' : 'Confirm you have read and understood this notice.')) + '</span>';
            html += '</label>';
        });
        html += '</div>';
        html += '</div>';
    });
    html += '<div class="consent-footer-note">Your choices are recorded server-side and can be reviewed or withdrawn at any time from My Profile &gt; Consent.</div>';
    return html;
}

// Show the consent modal with pending notices.
async function showConsentModal() {
    const pending = await checkConsentRequired();
    if (!pending || pending.length === 0) return;
    document.getElementById('consentModalBody').innerHTML = buildConsentModalBody(pending);
    document.getElementById('consentBtnSkip').style.display = pending.every(n => !n.required) ? 'inline-block' : 'none';
    document.getElementById('consentBtnConfirm').style.display = pending.some(n => n.required) ? 'inline-block' : 'inline-block';
    document.getElementById('consentModal').classList.add('active');
}

function closeConsentModal() {
    document.getElementById('consentModal').classList.remove('active');
}

function closeConsentManageModal() {
    document.getElementById('consentManageModal').classList.remove('active');
}

// Record consent for one notice.
async function recordConsent(noticeKey, choice) {
    const res = await apiCall('/api/consent/record', 'POST', {
        notice_key: noticeKey,
        notice_version: '1.0',
        purpose: CONSENT_NOTICES.find(n => n.key === noticeKey)?.purpose || '',
        choice: choice,
        method: 'ui_modal',
        locale: 'en'
    });
    if (!res || !res.success) {
        showToast('Could not record your choice. Please try again.', 'error');
        return false;
    }
    return true;
}

// Confirm all consents and close the modal.
async function confirmConsents() {
    const modal = document.getElementById('consentModal');
    const pending = await checkConsentRequired();
    if (!pending || pending.length === 0) { closeConsentModal(); return; }

    let allRecorded = true;
    for (const notice of pending) {
        const selected = modal.querySelector('input[name="consent_' + notice.key + '"]:checked');
        if (!selected) {
            showToast('Please select an option for: ' + notice.title, 'error');
            return;
        }
        const choice = selected.value;
        // Required notices cannot be declined
        if (notice.required && choice === 'declined') {
            showToast(notice.title + ' is required to use the HRMS.', 'error');
            return;
        }
        const ok = await recordConsent(notice.key, choice);
        if (!ok) allRecorded = false;
    }
    if (!allRecorded) return;

    closeConsentModal();
    showToast('Thank you. Your consent choices are recorded.', 'success');

    // If attendance camera/location was declined, show the exception workflow
    const cam = pending.find(n => n.key === 'attendance_camera');
    const loc = pending.find(n => n.key === 'attendance_location');
    if (cam) {
        const camSelected = modal.querySelector('input[name="consent_attendance_camera"]:checked');
        if (camSelected && camSelected.value === 'declined') {
            setTimeout(() => showToast('Camera declined: contact HR for manual attendance recording exception.', 'info'), 1000);
        }
    }
    if (loc) {
        const locSelected = modal.querySelector('input[name="consent_attendance_location"]:checked');
        if (locSelected && locSelected.value === 'declined') {
            setTimeout(() => showToast('Location declined: contact HR for manual attendance recording exception.', 'info'), 1500);
        }
    }
}

// Show consent management modal (view + withdraw).
async function showConsentManageModal() {
    const res = await apiCall('/api/consent/mine', 'GET', null, { silent: true });
    if (!res || !res.success) {
        showToast('Could not load consent records.', 'error');
        return;
    }
    const consents = res.consent || [];
    let html = '<p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:16px;">Your recorded consent choices. Withdraw optional consent at any time.</p>';
    if (consents.length === 0) {
        html += '<p style="color:var(--text-secondary);">No consent records found.</p>';
    } else {
        consents.forEach(c => {
            const choiceColor = c.choice === 'granted' ? 'var(--success)' : (c.choice === 'declined' ? 'var(--danger)' : 'var(--info)');
            const withdrawn = c.choice === 'withdrawn' ? ' <span style="color:var(--danger);font-size:0.75rem;">(withdrawn ' + (c.withdrawal_timestamp ? c.withdrawal_timestamp.substring(0,16) : '') + ')</span>' : '';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-light);">';
            html += '<div><strong>' + escapeHtml(c.notice_key) + '</strong>' + withdrawn + '<div style="font-size:0.75rem;color:var(--text-secondary);margin-top:2px;">' + escapeHtml(c.purpose || '') + '</div></div>';
            html += '<div style="text-align:right;">';
            html += '<span style="color:' + choiceColor + ';font-weight:600;">' + c.choice + '</span>';
            html += '<div style="font-size:0.7rem;color:var(--text-tertiary);margin-top:2px;">' + (c.timestamp || '').substring(0,16) + '</div>';
            if (c.choice !== 'withdrawn') {
                html += '<button class="btn btn-sm btn-secondary" onclick="withdrawConsent(\'' + c.notice_key + '\')" style="margin-top:4px;">Withdraw</button>';
            }
            html += '</div>';
            html += '</div>';
        });
    }
    document.getElementById('consentManageBody').innerHTML = html;
    document.getElementById('consentManageModal').classList.add('active');
}

// Withdraw consent for a notice.
async function withdrawConsent(noticeKey) {
    if (!confirm('Withdraw consent for "' + noticeKey + '"? You can re-grant it later.')) return;
    const ok = await recordConsent(noticeKey, 'withdrawn');
    if (ok) {
        showToast('Consent withdrawn.', 'success');
        showConsentManageModal(); // refresh
    }
}

// Check consent on every page load when logged in.
document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
        const pending = await checkConsentRequired();
        if (pending && pending.length > 0) {
            // Defer slightly so the page renders first
            setTimeout(() => showConsentModal(), 500);
        }
    } catch (e) { /* consent check is best-effort */ }
});
