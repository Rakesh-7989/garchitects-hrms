const API_URL = '/api';

function getLoginUrl(user) {
    if (user && ['admin', 'hr', 'manager'].includes(user.role)) return '/admin/';
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
        if (user && user.role === 'admin') {
            window.location.href = '/admin/dashboard';
        } else if (user) {
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
                } else if (data.user.role === 'admin') {
                    window.location.href = '/admin/dashboard';
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
async function apiCall(endpoint, method = 'GET', body = null) {
    const token = localStorage.getItem('token');
    const headers = { 'Content-Type': 'application/json' };
    
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    
    const options = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }
    
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
        console.error('API Error:', error);
        showToast('Network error. Please try again.', 'error');
        return null;
    }
}

// Logout function
async function logout() {
    const token = localStorage.getItem('token');
    const user = getCurrentUser();
    const loginUrl = getLoginUrl(user);
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
    const d = new Date(dateString);
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
    } catch (e) {}
});

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
