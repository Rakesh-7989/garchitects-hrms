// Dashboard JavaScript for G-Architects HRMS

// Toggle sidebar
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.getElementById('mainContent');
    
    if (window.innerWidth <= 1024) {
        const isActive = sidebar.classList.toggle('active');
        if (isShellApp()) {
            const bd = getSidebarBackdrop();
            bd.classList.toggle('show', isActive);
        }
    } else {
        sidebar.classList.toggle('collapsed');
        mainContent.classList.toggle('expanded');
    }
}

function getSidebarBackdrop() {
    let bd = document.getElementById('sidebarBackdrop');
    if (!bd) {
        bd = document.createElement('div');
        bd.id = 'sidebarBackdrop';
        bd.className = 'sidebar-backdrop';
        document.body.appendChild(bd);
        bd.addEventListener('click', () => {
            const sidebar = document.getElementById('sidebar');
            if (sidebar) sidebar.classList.remove('active');
            bd.classList.remove('show');
        });
    }
    return bd;
}

// Toggle dark mode
function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const icon = document.getElementById('themeIcon');
    
    if (document.body.classList.contains('dark-mode')) {
        icon.classList.remove('fa-moon');
        icon.classList.add('fa-sun');
        localStorage.setItem('theme', 'dark');
    } else {
        icon.classList.remove('fa-sun');
        icon.classList.add('fa-moon');
        localStorage.setItem('theme', 'light');
    }
    // Pages with charts/theme-aware rendering listen for this.
    document.dispatchEvent(new CustomEvent('themechange', { detail: { dark: document.body.classList.contains('dark-mode') } }));
}

// Toggle profile menu
function toggleProfileMenu() {
    const menu = document.getElementById('profileMenu');
    if (menu) {
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }
}

// Notification dropdown panel (employees)
let notificationPanelEl = null;

function toggleNotificationPanel() {
    const bell = document.querySelector('.notification-btn[title="Notifications"]');
    if (!bell) return;
    const user = getCurrentUser();
    if (!user) return;

    if (notificationPanelEl && notificationPanelEl.parentElement === bell) {
        notificationPanelEl.remove();
        notificationPanelEl = null;
        return;
    }

    if (notificationPanelEl) notificationPanelEl.remove();

    notificationPanelEl = document.createElement('div');
    notificationPanelEl.className = 'notification-panel';
    notificationPanelEl.id = 'notificationPanel';
    notificationPanelEl.innerHTML = `
        <div class="notification-panel-header">
            <span><i class="fas fa-bell" style="margin-right:6px;"></i>Notifications</span>
            <button class="mark-all-btn" id="markAllReadBtn">Mark all as read</button>
        </div>
        <div class="notification-panel-list" id="notificationList" style="min-height:60px;">
            <div class="notification-panel-empty"><i class="fas fa-spinner fa-spin"></i>Loading...</div>
        </div>
        <div class="notification-panel-footer">
            <a href="/employee/announcements">View all announcements</a>
        </div>
    `;

    bell.appendChild(notificationPanelEl);
    loadNotificationList();

    const markAllBtn = document.getElementById('markAllReadBtn');
    markAllBtn.onclick = async function(e) {
        e.preventDefault();
        e.stopPropagation();
        // Two independent stores: directed messages (user_notifications) and
        // announcements. Both must clear or the badge just reappears.
        await Promise.all([
            apiCall('/notifications/read-all', 'POST'),
            apiCall('/announcements/read-all', 'POST')
        ]);
        loadNotifBadge();
        loadNotificationList();
    };
}

// ─────────────────────────────────────────────────────────────────
// Employee notification panel.
//
// Previously this listed ONLY announcements. Work assigned to an employee, a
// lead's project risk, or "your teammate's manager was told" had no employee-
// visible surface at all: /notifications/counts and /notifications/requests are
// isManager-only, so the employee branch of the bell fell through to
// /announcements/unread-count and there was nowhere else to look. Both stores are
// now shown, directed messages first (they are the actionable ones).
// ─────────────────────────────────────────────────────────────────
const NOTIF_ICON = {
    work_assigned: 'fa-clipboard-list',
    work_completed: 'fa-circle-check',
    work_cancelled: 'fa-ban',
    work_started: 'fa-play',
    work_update: 'fa-file-lines',
    project_status: 'fa-flag'
};
const NOTIF_COLOR = {
    work_assigned: '#2563eb',
    work_completed: '#16a34a',
    work_cancelled: '#dc2626',
    work_started: '#0891b2',
    work_update: '#7c3aed',
    project_status: '#ea580c'
};

async function loadNotificationList() {
    const list = document.getElementById('notificationList');
    if (!list) return;
    try {
        const [feed, ann] = await Promise.all([
            apiCall('/notifications/feed?limit=25'),
            apiCall('/announcements')
        ]);

        const directed = (feed && feed.success ? (feed.feed || []) : []).map(n => ({
            kind: 'directed',
            id: n.id,
            title: n.title || '',
            body: n.body || '',
            url: n.url || '',
            read: !!n.read_at,
            created_at: n.created_at,
            type: n.type
        }));
        const announcements = (ann && ann.success ? (ann.announcements || []) : []).map(a => ({
            kind: 'announcement',
            id: a.id,
            title: a.title || '',
            priority: a.priority || 'normal',
            read: !!a.is_read,
            created_at: a.created_at
        }));

        const all = [...directed, ...announcements]
            .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
            .slice(0, 12);

        if (all.length === 0) {
            list.innerHTML = '<div class="notification-panel-empty"><i class="fas fa-bell-slash"></i>Nothing new</div>';
            return;
        }

        list.innerHTML = all.map(n => {
            const time = formatTimeAgo(n.created_at);
            if (n.kind === 'directed') {
                const color = NOTIF_COLOR[n.type] || 'var(--primary)';
                const icon = NOTIF_ICON[n.type] || 'fa-bell';
                return `
                    <a href="javascript:void(0)" class="notification-item ${n.read ? 'is-read' : ''}" data-kind="directed" data-id="${n.id}" data-url="${escapeHtml(n.url || '')}">
                        <span class="notif-dot"></span>
                        <div class="notif-body">
                            <div class="notif-title"><i class="fas ${icon}" style="color:${color};margin-right:5px;"></i>${escapeHtml(n.title)}</div>
                            ${n.body ? `<div style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;line-height:1.35;">${escapeHtml(n.body)}</div>` : ''}
                            <div class="notif-meta"><span>${time}</span></div>
                        </div>
                    </a>`;
            }
            const prio = n.priority || 'normal';
            const prioColor = getPriorityColor(prio);
            return `
                <a href="javascript:void(0)" class="notification-item ${n.read ? 'is-read' : ''}" data-kind="announcement" data-id="${n.id}">
                    <span class="notif-dot"></span>
                    <div class="notif-body">
                        <div class="notif-title">${escapeHtml(n.title)}</div>
                        <div class="notif-meta">
                            <span class="priority-tag" style="background:${prioColor}22;color:${prioColor};">${prio.toUpperCase()}</span>
                            <span>${time}</span>
                        </div>
                    </div>
                </a>`;
        }).join('');

        list.querySelectorAll('.notification-item').forEach(item => {
            item.addEventListener('click', async () => {
                const id = item.getAttribute('data-id');
                const kind = item.getAttribute('data-kind');
                const url = item.getAttribute('data-url');
                if (!item.classList.contains('is-read')) {
                    if (kind === 'directed') await apiCall('/notifications/' + id + '/read', 'POST');
                    else await apiCall('/announcements/' + id + '/read', 'POST');
                    loadNotifBadge();
                }
                // An unread directed message with nowhere to go is a dead end, so
                // fall back to My Work rather than leaving the employee on the
                // same page.
                window.location.href = (kind === 'directed' && url) ? url : '/employee/announcements';
            });
        });
    } catch (e) {
        list.innerHTML = '<div class="notification-panel-empty"><i class="fas fa-exclamation-circle"></i>Failed to load</div>';
    }
}

function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    let iso = String(dateStr).trim();
    if (!iso.endsWith('Z') && !iso.match(/[+-]\d{2}:\d{2}$/)) iso = iso.replace(' ', 'T') + 'Z';
    else iso = iso.replace(' ', 'T');
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    const diff = Date.now() - date.getTime();
    if (isNaN(diff) || diff < 0) return 'Just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return formatDate(dateStr);
}

// escapeHtml() is defined once in js/auth.js, which every page loads before
// this file - do not redeclare it here (duplicate declarations silently
// shadow the original and drift out of sync).

function formatHours(h) {
    const val = parseFloat(h) || 0;
    if (val === 0) return '0h';
    let rounded = Math.round(val * 100) / 100;
    if (rounded === Math.floor(rounded)) {
        return rounded + 'h';
    }
    return rounded.toFixed(2).replace(/\.?0+$/, '') + 'h';
}

// Load user info into sidebar/profile
function loadUserInfo() {
    const user = getCurrentUser();
    if (!user) return;
    
    const userNameEl = document.getElementById('userName');
    const userRoleEl = document.getElementById('userRole');
    const profileNameEl = document.getElementById('profileName');
    const profilePhotoEls = document.querySelectorAll('.profile-photo');
    
    const fullName = `${user.first_name} ${user.last_name}`;
    const roleLabel = { employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager', hr: 'HR', admin: 'Admin' }[user.role] || (user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : '');
    if (userNameEl) userNameEl.textContent = fullName;
    if (userRoleEl) userRoleEl.textContent = roleLabel;
    if (profileNameEl) profileNameEl.textContent = fullName;
    
    const initials = ((user.first_name || '')[0] || '') + ((user.last_name || '')[0] || '');
    profilePhotoEls.forEach(el => {
        if (user.profile_photo) {
            el.innerHTML = '<img src="' + escapeHtml(user.profile_photo) + '" alt="Profile" data-initials="' + escapeHtml(initials.toUpperCase()) + '" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block;" onerror="this.remove();this.parentElement.textContent=this.getAttribute(\'data-initials\');">';
        } else {
            el.textContent = initials.toUpperCase();
        }
    });

    loadManagerNav();
    loadNotifBadge();
    loadSidebarLogo();
    initNotificationBell();
}

// Notification bell: route by role.
//   admin             -> pending employee requests (leave / WFH / queries)
//   manager/team_lead -> their team's pending requests (added in manager flow)
//   employee          -> announcements
function initNotificationBell() {
    const user = getCurrentUser();
    if (!user) return;
    document.querySelectorAll('.notification-btn[title="Notifications"]').forEach(bell => {
        if (bell.getAttribute('data-requests-init')) return;
        bell.setAttribute('data-requests-init', 'true');
        bell.style.position = 'relative';
        bell.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (user.role === 'admin') {
                toggleAdminRequestsPanel(bell, 'admin');
            } else if (user.role === 'manager' || user.role === 'team_lead') {
                toggleAdminRequestsPanel(bell, 'manager');
            } else {
                toggleNotificationPanel();
            }
        };
    });
    document.addEventListener('click', function(e) {
        document.querySelectorAll('.notification-panel').forEach(p => {
            if (p.id === 'adminNotifPanel' && !p.contains(e.target) && !e.target.closest('.notification-btn[data-requests-init]')) {
                p.remove();
            }
        });
    });
}

async function toggleAdminRequestsPanel(bell, mode) {
    mode = mode || 'admin';
    const isManagerMode = mode === 'manager';
    const existing = document.getElementById('adminNotifPanel');
    if (existing) { existing.remove(); return; }

    const requestsUrl = isManagerMode ? '/manager/my-team' : '/admin/leave?status=pending';
    const announcementsUrl = isManagerMode ? '/employee/announcements' : '/admin/announcements';

    const announcementsSection = isManagerMode ?
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px 2px;border-top:1px solid var(--border-light);">' +
        '<span style="font-size:0.72rem;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.4px;">Announcements</span>' +
        '<button class="mark-all-btn" id="notifMarkAllBtn">Mark all as read</button></div>' +
        '<div class="notification-panel-list" id="notifAnnounceList" style="min-height:40px;"><div class="notification-panel-empty"><i class="fas fa-spinner fa-spin"></i>Loading...</div></div>' +
        '<div class="notification-panel-footer"><a href="' + announcementsUrl + '">View all announcements</a></div>' : '';

    // Directed messages (work assigned / completed, a report posted, a project
    // risk) are the same store the employee bell reads. Shown to every role so a
    // manager sees "GA0004 finished the task I gave them" without opening the
    // assignment list, and so the badge count and the panel never disagree.
    const directedSection =
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px 2px;border-top:1px solid var(--border-light);">' +
        '<span style="font-size:0.72rem;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.4px;">Updates for you</span>' +
        '<button class="mark-all-btn" id="notifDirectedMarkAllBtn">Mark all as read</button></div>' +
        '<div class="notification-panel-list" id="notifDirectedList" style="min-height:40px;"><div class="notification-panel-empty"><i class="fas fa-spinner fa-spin"></i>Loading...</div></div>';

    const panel = document.createElement('div');
    panel.className = 'notification-panel';
    panel.id = 'adminNotifPanel';
    panel.innerHTML =
        '<div class="notification-panel-header"><span><i class="fas fa-bell" style="margin-right:6px;"></i>Notifications</span></div>' +
        '<div style="font-size:0.72rem;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.4px;padding:8px 16px 2px;">' + (isManagerMode ? 'Team Requests' : 'Pending Requests') + '</div>' +
        '<div class="notification-panel-list" id="adminNotifList" style="min-height:50px;"><div class="notification-panel-empty"><i class="fas fa-spinner fa-spin"></i>Loading...</div></div>' +
        '<div class="notification-panel-footer"><a href="' + requestsUrl + '">View all requests</a></div>' +
        directedSection +
        announcementsSection;
    bell.appendChild(panel);

    await loadRequestsSection(document.getElementById('adminNotifList'), mode, 3);
    loadDirectedNotificationsSection(document.getElementById('notifDirectedList'));

    if (isManagerMode) {
        await loadAnnouncementsSection(document.getElementById('notifAnnounceList'), announcementsUrl);
        const markAllBtn = document.getElementById('notifMarkAllBtn');
        if (markAllBtn) {
            markAllBtn.onclick = async function(e) {
                e.preventDefault();
                e.stopPropagation();
                await apiCall('/announcements/read-all', 'POST');
                loadNotifBadge();
                loadAnnouncementsSection(document.getElementById('notifAnnounceList'), announcementsUrl);
            };
        }
    }
    const directedMarkAll = document.getElementById('notifDirectedMarkAllBtn');
    if (directedMarkAll) {
        directedMarkAll.onclick = async function(e) {
            e.preventDefault();
            e.stopPropagation();
            await apiCall('/notifications/read-all', 'POST');
            loadNotifBadge();
            loadDirectedNotificationsSection(document.getElementById('notifDirectedList'));
        };
    }
    loadNotifBadge();
}

/**
 * Render the directed-message section of the manager/admin bell.
 * Same data the employee bell shows, so a manager sees the work they handed out
 * coming back to them ("GA0006 completed: Pour concrete").
 */
async function loadDirectedNotificationsSection(listEl) {
    if (!listEl) return;
    try {
        const data = await apiCall('/notifications/feed?limit=15');
        const all = (data && data.success && data.feed) ? data.feed : [];
        if (!all.length) {
            listEl.innerHTML = '<div class="notification-panel-empty"><i class="fas fa-bell-slash"></i>Nothing yet</div>';
            return;
        }
        listEl.innerHTML = all.slice(0, 8).map(n => {
            const color = NOTIF_COLOR[n.type] || 'var(--primary)';
            const icon = NOTIF_ICON[n.type] || 'fa-bell';
            const title = escapeHtml(n.title || '');
            const body = n.body ? escapeHtml(String(n.body).slice(0, 140)) : '';
            const time = formatTimeAgo(n.created_at);
            return '<a href="javascript:void(0)" class="notification-item ' + (n.read_at ? 'is-read' : '') + '" data-id="' + n.id + '" data-url="' + escapeHtml(n.url || '') + '">' +
                '<span style="width:34px;height:34px;border-radius:50%;background:var(--primary-50);color:' + color + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;"><i class="fas ' + icon + '"></i></span>' +
                '<span class="notif-body"><span class="notif-title">' + title + '</span>' +
                (body ? '<span style="font-size:0.78rem;color:var(--text-secondary);display:block;line-height:1.35;margin-top:2px;">' + body + '</span>' : '') +
                '<span class="notif-meta">' + time + '</span></span></a>';
        }).join('');

        listEl.querySelectorAll('.notification-item').forEach(item => {
            item.addEventListener('click', async e => {
                e.preventDefault();
                e.stopPropagation();
                const id = item.getAttribute('data-id');
                const url = item.getAttribute('data-url');
                if (!item.classList.contains('is-read')) {
                    await apiCall('/notifications/' + id + '/read', 'POST');
                    loadNotifBadge();
                }
                if (url) window.location.href = url;
            });
        });
    } catch (err) {
        listEl.innerHTML = '<div class="notification-panel-empty"><i class="fas fa-exclamation-circle"></i>Failed to load</div>';
    }
}

async function loadRequestsSection(listEl, mode, limit) {
    limit = limit || 3;
    if (!listEl) return;
    const data = await apiCall('/notifications/requests');
    const feed = (data && data.success && data.feed) ? data.feed : [];
    if (feed.length === 0) {
        listEl.innerHTML = '<div class="notification-panel-empty"><i class="fas fa-bell-slash"></i>No pending requests</div>';
        return;
    }
    const iconMap = { leave: 'fa-calendar-times', wfh: 'fa-home', ticket: 'fa-ticket-alt', profile: 'fa-user-edit' };
    const colorMap = { leave: 'var(--accent)', wfh: 'var(--primary)', ticket: 'var(--info)', profile: 'var(--warning)' };
    listEl.innerHTML = feed.slice(0, limit).map(r => {
        const icon = iconMap[r.type] || 'fa-bell';
        const color = colorMap[r.type] || 'var(--primary)';
        return '<a href="' + escapeHtml(r.url) + '" class="notification-item">' +
            '<span style="width:34px;height:34px;border-radius:50%;background:var(--primary-50);color:' + color + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;"><i class="fas ' + icon + '"></i></span>' +
            '<span class="notif-body"><span class="notif-title">' + escapeHtml(r.title) + '</span>' +
            '<span class="notif-meta">' + escapeHtml(r.subtitle) + '</span></span></a>';
    }).join('');
}

async function loadAnnouncementsSection(listEl, announcementsUrl) {
    announcementsUrl = announcementsUrl || '/employee/announcements';
    if (!listEl) return;
    try {
        const data = await apiCall('/announcements');
        const all = (data && data.success && data.announcements) ? data.announcements : [];
        const items = all.slice().sort((a, b) => {
            if (a.is_read !== b.is_read) return a.is_read ? 1 : -1;
            return 0;
        }).slice(0, 3);
        if (items.length === 0) {
            listEl.innerHTML = '<div class="notification-panel-empty"><i class="fas fa-bell-slash"></i>No announcements</div>';
            return;
        }
        listEl.innerHTML = items.map(a => {
            const unreadClass = a.is_read ? 'is-read' : '';
            const time = formatTimeAgo(a.created_at);
            return '<a href="javascript:void(0)" class="notification-item ' + unreadClass + '" data-id="' + a.id + '">' +
                '<span class="notif-dot"></span>' +
                '<span class="notif-body"><span class="notif-title">' + escapeHtml(a.title) + '</span>' +
                '<span class="notif-meta">' + time + '</span></span></a>';
        }).join('');
        listEl.querySelectorAll('.notification-item').forEach(item => {
            item.addEventListener('click', async () => {
                const id = item.getAttribute('data-id');
                if (!item.classList.contains('is-read')) {
                    await apiCall('/announcements/' + id + '/read', 'POST');
                    loadNotifBadge();
                }
                window.location.href = announcementsUrl;
            });
        });
    } catch (e) {
        listEl.innerHTML = '';
    }
}

// Inject a "My Team" link into the sidebar for approver-role users,
// placed right after the Dashboard link (active on the My Team page).
function loadManagerNav() {
    const user = getCurrentUser();
    if (!user) return;
    if (user.role !== 'manager' && user.role !== 'team_lead') return;
    const nav = document.querySelector('.sidebar-nav');
    if (!nav || nav.querySelector('[data-manager-nav]')) return;
    if (nav.querySelector('a.nav-item[href="/manager/my-team"]')) return;
    const link = document.createElement('a');
    link.href = '/manager/my-team';
    link.className = 'nav-item';
    link.setAttribute('data-manager-nav', 'true');
    link.innerHTML = '<i class="fas fa-users"></i><span class="nav-text">My Team</span>';
    const dashboardLink = nav.querySelector('a.nav-item[href*="dashboard.html"]');
    if (dashboardLink) {
        if (window.location.pathname.indexOf('/manager/my-team') !== -1) {
            link.classList.add('active');
            dashboardLink.classList.remove('active');
        }
        dashboardLink.insertAdjacentElement('afterend', link);
    } else {
        nav.appendChild(link);
    }
}

async function loadNotifBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    const user = getCurrentUser();
    if (!user) return;
    try {
        let count = 0;
        if (user.role === 'admin' || user.role === 'hr') {
            // HR has the same pending-action surface as admin (incl. Team Work),
            // and the server already computes org-wide counts for role 'hr'.
            const data = await apiCall('/notifications/counts');
            if (data && data.success) {
                count = data.counts.pendingLeaves + data.counts.pendingWfh + data.counts.pendingProfileUpdates + data.counts.announcementsUnread + data.counts.pendingTickets + (parseInt(data.counts.openWorkAssignments) || 0) + (parseInt(data.counts.openLeadProjects) || 0) + (parseInt(data.counts.pendingTransfers) || 0) + (parseInt(data.counts.pendingAccessRequests) || 0) + (parseInt(data.counts.activeHandovers) || 0) + (parseInt(data.counts.unreadNotifications) || 0);
                loadSidebarCounts(data.counts);
            }
        } else if (user.role === 'manager' || user.role === 'team_lead') {
            const data = await apiCall('/notifications/counts');
            if (data && data.success) {
                count = data.counts.pendingLeaves + data.counts.pendingWfh + data.counts.pendingTickets + data.counts.announcementsUnread + (parseInt(data.counts.openWorkAssignments) || 0) + (parseInt(data.counts.openLeadProjects) || 0) + (parseInt(data.counts.pendingTransfers) || 0) + (parseInt(data.counts.pendingAccessRequests) || 0) + (parseInt(data.counts.activeHandovers) || 0) + (parseInt(data.counts.unreadNotifications) || 0);
                loadSidebarCounts(data.counts, 'manager');
            }
        } else {
            // Employees: announcements PLUS directed messages (work assigned, a
            // project risk, a teammate's report routed to them). Previously only
            // announcements were counted, so an employee could never see that
            // something had been assigned to them.
            const [ann, direct] = await Promise.all([
                apiCall('/announcements/unread-count'),
                apiCall('/notifications/unread-count')
            ]);
            count = (ann && ann.success ? parseInt(ann.count) || 0 : 0)
                + (direct && direct.success ? parseInt(direct.count) || 0 : 0);
        }
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.style.display = 'inline-flex';
        } else {
            badge.style.display = 'none';
        }
    } catch (e) {
        badge.style.display = 'none';
    }
}

// Show pending-action counts next to sidebar menu items.
// mode 'manager' -> "My Team" (their team's pending leave/WFH/tickets).
// mode 'admin'   -> Leave/WFH/Queries/Employees menu items.
function loadSidebarCounts(counts, mode) {
    if (!counts) return;
    const map = mode === 'manager'
        ? {
            '/manager/my-team': counts.pendingLeaves + counts.pendingWfh + counts.pendingTickets + (parseInt(counts.pendingTransfers) || 0) + (parseInt(counts.activeHandovers) || 0),
            '/manager/team-work': parseInt(counts.openWorkAssignments) || 0,
            '/manager/led-projects': parseInt(counts.openLeadProjects) || 0,
            '/manager/team-projects': (parseInt(counts.pendingAccessRequests) || 0) + (parseInt(counts.activeHandovers) || 0)
        }
        : {
            '/admin/leave': counts.pendingLeaves,
            '/admin/wfh': counts.pendingWfh,
            '/admin/tickets': counts.pendingTickets,
            '/admin/employees': counts.pendingProfileUpdates,
            '/manager/team-work': parseInt(counts.openWorkAssignments) || 0,
            '/manager/led-projects': parseInt(counts.openLeadProjects) || 0,
            '/manager/team-projects': (parseInt(counts.pendingAccessRequests) || 0) + (parseInt(counts.activeHandovers) || 0),
            '/manager/my-team': (parseInt(counts.pendingTransfers) || 0) + (parseInt(counts.activeHandovers) || 0)
        };
    Object.keys(map).forEach(href => {
        const item = document.querySelector('.sidebar-nav a.nav-item[href="' + href + '"]');
        if (!item) return;
        const n = parseInt(map[href]) || 0;
        let badge = item.querySelector('.nav-badge');
        if (n > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'nav-badge';
                item.appendChild(badge);
            }
            badge.textContent = n > 99 ? '99+' : n;
            badge.style.display = '';
        } else {
            if (badge) badge.remove();
        }
    });
}

// Load sidebar logo
function loadSidebarLogo() {
    const logoEls = document.querySelectorAll('.sidebar-logo');
    logoEls.forEach(el => {
        el.innerHTML = '<i class="fas fa-building" style="color:var(--primary-light);font-size:1.5rem;"></i><span style="font-size:1rem;font-weight:700;">G-Architects HRMS</span>';
    });
}

// Show confirm dialog (replaces browser confirm).
// Optional 6th arg onCancel fires when the dialog is dismissed without confirming
// (Cancel button, close X, or overlay click). Backwards-compatible: existing 5-arg
// callers never receive onCancel and behave exactly as before.
function showConfirmDialog(title, message, confirmText, confirmBtnClass, onConfirm, onCancel) {
    const existing = document.getElementById('confirmDialogOverlay');
    if (existing) existing.remove();

    const dismiss = function() {
        overlay.remove();
        if (typeof onCancel === 'function') onCancel();
    };

    const overlay = document.createElement('div');
    overlay.id = 'confirmDialogOverlay';
    overlay.className = 'modal active';
    overlay.onclick = function(e) { if (e.target === this) { dismiss(); } };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '420px';
    content.onclick = function(e) { e.stopPropagation(); };

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = '<h2><i class="fas fa-exclamation-triangle" style="color:var(--warning);margin-right:8px;"></i>' + escapeHtml(title) + '</h2><button class="modal-close" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-secondary);">&times;</button>';
    const closeBtn = header.querySelector('.modal-close');
    if (closeBtn) closeBtn.onclick = dismiss;

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.innerHTML = '<p style="line-height:1.6;white-space:pre-wrap;">' + escapeHtml(message) + '</p>';

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = dismiss;
    footer.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn ' + (confirmBtnClass || 'btn-danger');
    confirmBtn.innerHTML = '<i class="fas fa-check"></i> ' + (confirmText || 'Confirm');
    confirmBtn.onclick = function() {
        overlay.remove();
        if (typeof onConfirm === 'function') onConfirm();
    };

    footer.appendChild(confirmBtn);
    content.appendChild(header);
    content.appendChild(body);
    content.appendChild(footer);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
}

// Show skeleton loader
function showSkeleton(container, count = 3) {
    if (!container) return;
    let html = '';
    for (let i = 0; i < count; i++) {
        html += `
            <div class="skeleton-card skeleton" style="margin-bottom: 12px;"></div>
        `;
    }
    container.innerHTML = html;
}

// Show empty state
function showEmptyState(container, icon, title, message) {
    if (!container) return;
    container.innerHTML = `
        <div class="empty-state">
            <i class="fas ${escapeHtml(icon)}"></i>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

// Helper functions
function getPriorityColor(priority) {
    const colors = {
        low: '#10B981',
        normal: '#4F46E5',
        high: '#F59E0B',
        urgent: '#EF4444'
    };
    return colors[priority] || colors.normal;
}

function getPriorityBadge(priority) {
    const badges = {
        low: 'success',
        normal: 'info',
        high: 'warning',
        urgent: 'danger'
    };
    return badges[priority] || 'info';
}

function getStatusBadge(status) {
    const badges = {
        active: 'success',
        inactive: 'secondary',
        paused: 'warning',
        on_hold: 'warning',
        absconded: 'danger',
        terminated: 'danger',
        pending: 'warning',
        approved: 'success',
        rejected: 'danger',
        present: 'success',
        absent: 'danger',
        'half-day': 'warning',
        late: 'warning',
        paid: 'success',
        processed: 'info',
        draft: 'secondary',
        open: 'warning',
        in_progress: 'info',
        resolved: 'success',
        closed: 'secondary',
        low: 'secondary',
        normal: 'info',
        medium: 'warning',
        high: 'danger',
        urgent: 'danger'
    };
    return badges[status] || 'secondary';
}

function getStatusText(status) {
    const labels = {
        present: 'Present',
        absent: 'Absent',
        late: 'Late Login',
        'half-day': 'Half Day',
        pending: 'Pending',
        approved: 'Approved',
        rejected: 'Rejected',
        open: 'Open',
        in_progress: 'In Progress',
        resolved: 'Resolved',
        closed: 'Closed',
        low: 'Low',
        medium: 'Medium',
        high: 'High'
    };
    return labels[status] || status;
}

// Close profile menu when clicking outside
document.addEventListener('click', (e) => {
    const profileBtn = document.querySelector('.profile-btn');
    const profileMenu = document.getElementById('profileMenu');
    
    if (profileBtn && profileMenu && !profileBtn.contains(e.target) && !profileMenu.contains(e.target)) {
        profileMenu.style.display = 'none';
    }

    const bell = document.querySelector('.notification-btn[title="Notifications"]');
    const panel = document.getElementById('notificationPanel');
    if (bell && panel && !bell.contains(e.target)) {
        panel.remove();
        notificationPanelEl = null;
    }
});

// Close sidebar on mobile when clicking outside
document.addEventListener('click', (e) => {
    const sidebar = document.getElementById('sidebar');
    const menuToggle = document.querySelector('.menu-toggle');
    
    if (window.innerWidth <= 1024 && sidebar && menuToggle) {
        if (!sidebar.contains(e.target) && !menuToggle.contains(e.target)) {
            sidebar.classList.remove('active');
        }
    }
});

// Initialize page
document.addEventListener('DOMContentLoaded', () => {
    loadUserInfo();

    // Real-time notification badge: refresh every 30s while the app is open
    setInterval(() => {
        if (getCurrentUser()) loadNotifBadge();
    }, 30000);
    
    // Handle responsive sidebar
    const handleResize = () => {
        const sidebar = document.getElementById('sidebar');
        if (window.innerWidth <= 1024) {
            sidebar.classList.remove('collapsed');
        } else {
            const bd = document.getElementById('sidebarBackdrop');
            if (bd) {
                sidebar.classList.remove('active');
                bd.classList.remove('show');
            }
        }
    };
    
    window.addEventListener('resize', handleResize);
    handleResize();

    initAdminMobile();
});

// --- App shell mobile helpers (gated on admin/employee app body class) ---

function isShellApp() {
    return document.body.classList.contains('admin-app') ||
        document.body.classList.contains('employee-app');
}

let adminTableTimer = null;

function adminStampTableLabels() {
    document.querySelectorAll('.table-container table').forEach(table => {
        const theadRow = table.querySelector('thead tr');
        const tbody = table.querySelector('tbody');
        if (!theadRow || !tbody) return;
        const headers = Array.from(theadRow.querySelectorAll('th')).map(th => th.textContent.trim());
        tbody.querySelectorAll('tr').forEach(row => {
            Array.from(row.children).forEach((td, i) => {
                const want = headers[i] || '';
                if (td.getAttribute('data-label') !== want) td.setAttribute('data-label', want);
                // Mobile card layout hints: first column acts as the card title,
                // action columns render as an inline button row without a label.
                td.classList.toggle('cell-title', i === 0 && row.children.length > 1 && !td.hasAttribute('colspan'));
                td.classList.toggle('cell-actions', /^action/i.test(want));
            });
        });
    });
}

function adminTableRescan() {
    if (adminTableTimer) clearTimeout(adminTableTimer);
    adminTableTimer = setTimeout(adminStampTableLabels, 60);
}

function initAdminMobile() {
    if (!isShellApp()) return;
    adminStampTableLabels();
    const mo = new MutationObserver(adminTableRescan);
    mo.observe(document.body, { childList: true, subtree: true });
}
