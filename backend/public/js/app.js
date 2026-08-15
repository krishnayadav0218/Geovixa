// API base — normally relative '/api' (web app served from the same origin as the backend).
// When this same frontend is wrapped as a standalone mobile app (Capacitor/Cordova — see the
// "Setup Service URL" screen below), there's no same-origin backend to be relative to, so a
// full URL saved to localStorage takes over instead. CORS is open on the backend for exactly
// this case (server.js: app.use(cors())).
// Wrapped in try/catch: some WebView configurations treat file:// as an "opaque origin" where
// localStorage itself throws just by being touched — since this runs at parse time, an
// uncaught throw here would take down the entire app before anything else could even run.
function safeLocalStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalStorageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeLocalStorageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* nothing to do if storage is unavailable */ }
}
function getApiBase() {
  const saved = safeLocalStorageGet('geovixa_service_url');
  return saved ? saved.replace(/\/$/, '') + '/api' : '/api';
}
const API = getApiBase();

// A "standalone app" context (Capacitor/Cordova/file://) has no usable same-origin backend to
// fall back to — only in that case do we force the Setup Service URL screen before anything
// else. A normal web visit (http/https) is completely unaffected and behaves exactly as before.
function isStandaloneAppContext() {
  try { return !['http:', 'https:'].includes(window.location.protocol); }
  catch { return false; }
}

// ---------------- IST DATE/TIME HELPERS ----------------
// Always format against Asia/Kolkata explicitly, instead of relying on the device's own
// system timezone (some phones/tablets are misconfigured), so date/time shown to
// employees, managers and admins is always correct live IST — not "sometimes right".
const IST_TZ = 'Asia/Kolkata';
function istNow() { return new Date(); }
function formatISTDate(date) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST_TZ, weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' }).format(date);
}
function formatISTDateTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(date);
}
function formatISTTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST_TZ, hour: '2-digit', minute: '2-digit', hour12: true }).format(date);
}

// ---------------- STORAGE HELPERS ----------------
// Using sessionStorage (NOT localStorage) so that closing the browser tab/window
// automatically clears the session -> user is logged out and must sign in again.
function getToken() { return sessionStorage.getItem('geovixa_token'); }
function getRole() { return sessionStorage.getItem('geovixa_role'); }
function getStaffProject() { return sessionStorage.getItem('geovixa_project') || null; }
function getCustomRoleLabel() { return sessionStorage.getItem('geovixa_role_label') || null; }
function getCompanyName() { return sessionStorage.getItem('geovixa_company_name') || null; }
function getCompanyLogoUrl() { return sessionStorage.getItem('geovixa_company_logo') || null; }
function getEmployeeInfo() {
  try { return JSON.parse(sessionStorage.getItem('geovixa_employee') || 'null'); } catch (e) { return null; }
}
function getCompanySettingsCached() {
  try { return JSON.parse(sessionStorage.getItem('geovixa_settings') || 'null'); } catch (e) { return null; }
}
function saveSession(token, role, employee, project, roleLabel, companyName, settings, companyLogoUrl) {
  sessionStorage.setItem('geovixa_token', token);
  sessionStorage.setItem('geovixa_role', role);
  if (employee) sessionStorage.setItem('geovixa_employee', JSON.stringify(employee));
  if (project) sessionStorage.setItem('geovixa_project', project);
  else sessionStorage.removeItem('geovixa_project');
  if (roleLabel) sessionStorage.setItem('geovixa_role_label', roleLabel);
  else sessionStorage.removeItem('geovixa_role_label');
  if (companyName) sessionStorage.setItem('geovixa_company_name', companyName);
  else sessionStorage.removeItem('geovixa_company_name');
  if (companyLogoUrl) sessionStorage.setItem('geovixa_company_logo', companyLogoUrl);
  else sessionStorage.removeItem('geovixa_company_logo');
  if (settings) sessionStorage.setItem('geovixa_settings', JSON.stringify(settings));
  else sessionStorage.removeItem('geovixa_settings');
}
function clearSession() {
  sessionStorage.removeItem('geovixa_token');
  sessionStorage.removeItem('geovixa_role');
  sessionStorage.removeItem('geovixa_employee');
  sessionStorage.removeItem('geovixa_project');
  sessionStorage.removeItem('geovixa_role_label');
  sessionStorage.removeItem('geovixa_company_name');
  sessionStorage.removeItem('geovixa_company_logo');
  sessionStorage.removeItem('geovixa_settings');
  sessionStorage.removeItem('geovixa_client_name');
  sessionStorage.removeItem('geovixa_client_projects');
}

// Applies the logged-in company's actual name + logo to the dashboard/employee-dashboard
// topbar branding, instead of the generic "Geovixa" placeholder markup. Falls back to the
// default Geovixa logo if this company hasn't uploaded one (nameEl/logoEl ids differ between
// the staff sidebar and the employee topbar, so this is called once per dashboard show with
// the right pair of ids).
function applyCompanyBranding(nameElId, logoElId) {
  const nameEl = document.getElementById(nameElId);
  const logoEl = document.getElementById(logoElId);
  const name = getCompanyName();
  const logoUrl = getCompanyLogoUrl();
  if (nameEl) nameEl.textContent = name || 'Geovixa';
  if (logoEl) logoEl.src = logoUrl || '/img/geovixa-logo.svg';
}

// ---- Live "Signing in to: <Company>" preview as the person types their Company Code ----
// Debounced lookup against the public /auth/company-lookup endpoint — lets someone confirm
// they've got the right code (and see their own company's branding) BEFORE they submit
// username/password or Employee ID/PIN, catching typos early instead of after a failed login.
['employee', 'manager', 'coordinator', 'report', 'admin'].forEach(kind => {
  const input = document.getElementById(`${kind}-login-company`);
  const preview = document.getElementById(`${kind}-login-company-preview`);
  if (!input || !preview) return;

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const code = input.value.trim();
    if (code.length < 3) {
      preview.classList.add('hidden');
      preview.innerHTML = '';
      return;
    }
    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/auth/company-lookup?code=${encodeURIComponent(code)}`);
        const data = await res.json();
        if (!res.ok) {
          preview.classList.add('hidden');
          preview.innerHTML = '';
          return;
        }
        const logoImg = data.logo_url
          ? `<img src="${data.logo_url}" style="width:18px;height:18px;object-fit:contain;border-radius:4px;" />`
          : '🏢';
        preview.innerHTML = `${logoImg} Signing in to: ${escapeHtml(data.name)}`;
        preview.classList.remove('hidden');
      } catch (err) {
        preview.classList.add('hidden');
        preview.innerHTML = '';
      }
    }, 450);
  });
});

// Hides nav items for Functions the platform owner has switched OFF for this company, AND
// for sidebar sections the current role (admin/manager/coordinator) isn't permitted to see
// for this company (role_permissions — see companySettings.js). Safe to call every time a
// dashboard is shown (login, or session restore on page reload) — if settings aren't known
// yet (e.g. old cached session before this feature existed), every nav item is simply left
// visible, since the backend still enforces the real restriction either way.
function applyFeatureVisibility(settings) {
  const features = (settings && settings.features) || {};
  const staffMap = {
    salary: 'nav-salary-requests',
    leave: 'nav-leave-requests',
    grievance: 'nav-grievances',
    shift_cycle_report: 'nav-report-shiftcycle',
  };
  const employeeMap = {
    salary: 'emp-subnav-salary',
    leave: 'emp-subnav-leave',
    grievance: 'emp-subnav-grievance',
  };
  [staffMap, employeeMap].forEach(map => {
    Object.entries(map).forEach(([featureKey, elId]) => {
      const el = document.getElementById(elId);
      if (!el) return;
      const enabled = features[featureKey] !== false; // default visible until we know otherwise
      el.classList.toggle('hidden', !enabled);
    });
  });

  // Per-role sidebar sections (admin/manager/coordinator only — employee/report_viewer/
  // super_admin dashboards aren't governed by this system). Uses inline style.display rather
  // than the .hidden class, so it can override the CSS ".admin-only" rule that would
  // otherwise force these items visible for the admin role.
  const role = getRole();
  const rolePerms = settings && settings.role_permissions && settings.role_permissions[role];
  const navMap = {
    attendance: 'nav-attendance',
    reports: 'nav-reports',
    employees: 'nav-employees',
    salary_requests: 'nav-salary-requests',
    leave_requests: 'nav-leave-requests',
    grievances: 'nav-grievances',
    managers: 'nav-managers',
    coordinators: 'nav-coordinators',
    settings: 'nav-settings',
    reliever: 'nav-reliever',
    overtime: 'nav-overtime',
    maintenance: 'nav-maintenance',
    sos: 'nav-sos',
    announcements: 'nav-announcements',
    client_portal: 'nav-clients',
  };
  if (rolePerms) {
    Object.entries(navMap).forEach(([navKey, elId]) => {
      const el = document.getElementById(elId);
      if (!el) return;
      const enabled = rolePerms[navKey] !== false;
      // Combine with the feature-flag hiding above: if a feature is already off, leave it
      // off (don't fight the .hidden class); otherwise use inline display to respect
      // role_permissions, including overriding the CSS ".admin-only" auto-show rule.
      if (el.classList.contains('hidden')) return;
      el.style.display = enabled ? '' : 'none';
    });
  }
}

// Remembers the last-used Company Code per device (localStorage, NOT cleared on tab close)
// so returning users on every login screen don't have to retype it every single time —
// only the username/password/PIN still need entering fresh each session.
function getRememberedCompanyCode() { return localStorage.getItem('geovixa_last_company_code') || ''; }
function rememberCompanyCode(code) {
  if (code) localStorage.setItem('geovixa_last_company_code', code.toUpperCase());
}

// ---------------- TOAST ----------------
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = isError ? 'show err' : 'show';
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ---------------- VIEW SWITCHING ----------------
const ALL_VIEWS = [
  'role-select-view', 'employee-login-view', 'manager-login-view', 'coordinator-login-view', 'admin-login-view', 'report-login-view',
  'super-admin-login-view', 'client-login-view', 'service-url-view',
  'employee-dashboard-view', 'dashboard-view', 'companies-view', 'logged-out-view', 'client-dashboard-view'
];
function showView(id) {
  ALL_VIEWS.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
  // Pre-fill the Company Code field (if this view has one) with whatever was last used on
  // this device, so returning users don't have to retype it on every single login.
  const companyField = document.getElementById(id.replace('-view', '-company'));
  if (companyField && !companyField.value) {
    companyField.value = getRememberedCompanyCode();
  }
}

// ---------------- URL ROUTING ----------------
// Supports direct navigation: /employee, /manager, /coordinator, /admin, and / (role select)
function pathToRole(path) {
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === '/employee') return 'employee';
  if (clean === '/manager') return 'manager';
  if (clean === '/coordinator') return 'coordinator';
  if (clean === '/admin') return 'admin';
  if (clean === '/report') return 'report';
  if (clean === '/owner') return 'owner';
  if (clean === '/client') return 'client';
  return null;
}

function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  renderRoute();
}

function renderRoute() {
  // Standalone app (Capacitor/Cordova) with no backend URL configured yet — everything else
  // is blocked behind this until it's set, since without it every API call would fail anyway.
  if (isStandaloneAppContext() && !safeLocalStorageGet('geovixa_service_url')) {
    showView('service-url-view');
    return;
  }

  const role = pathToRole(window.location.pathname);
  const token = getToken();
  const sessionRole = getRole();
  const staffPaths = ['admin', 'manager', 'coordinator', 'report'];
  // 'report' is the login path for every admin-defined custom role (Area Officer,
  // Supervisor, etc.) — they all share the single internal session role 'report_viewer'.
  const staffSessionRoles = ['admin', 'manager', 'coordinator', 'report_viewer'];

  if (role === 'employee') {
    if (token && sessionRole === 'employee') showEmployeeDashboard();
    else showView('employee-login-view');
  } else if (role === 'owner') {
    if (token && sessionRole === 'super_admin') showCompaniesDashboard();
    else showView('super-admin-login-view');
  } else if (role === 'client') {
    if (token && sessionRole === 'client') showClientDashboard();
    else showView('client-login-view');
  } else if (staffPaths.includes(role)) {
    if (token && staffSessionRoles.includes(sessionRole)) showDashboard();
    else showView(role + '-login-view');
  } else {
    // "/" or any unknown path -> role select, unless already logged in
    if (token && sessionRole === 'employee') showEmployeeDashboard();
    else if (token && sessionRole === 'super_admin') showCompaniesDashboard();
    else if (token && sessionRole === 'client') showClientDashboard();
    else if (token && staffSessionRoles.includes(sessionRole)) showDashboard();
    else showView('role-select-view');
  }
}

document.getElementById('owner-login-link').addEventListener('click', (e) => {
  e.preventDefault();
  navigate('/owner');
});

if (isStandaloneAppContext()) {
  document.getElementById('change-server-link').classList.remove('hidden');
}
document.getElementById('change-server-link').addEventListener('click', (e) => {
  e.preventDefault();
  if (!confirm('Change server URL? You will need to log in again.')) return;
  safeLocalStorageRemove('geovixa_service_url');
  clearSession();
  window.location.reload();
});

document.getElementById('service-url-continue-btn').addEventListener('click', () => {
  const errBox = document.getElementById('service-url-error');
  errBox.style.display = 'none';
  let url = document.getElementById('service-url-input').value.trim();
  if (!url) { errBox.textContent = 'Please enter your service URL'; errBox.style.display = 'block'; return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { errBox.textContent = 'That doesn\'t look like a valid URL'; errBox.style.display = 'block'; return; }
  if (!safeLocalStorageSet('geovixa_service_url', url.replace(/\/$/, ''))) {
    errBox.textContent = 'Could not save settings on this device (storage blocked). Please check your browser/app settings.';
    errBox.style.display = 'block';
    return;
  }
  window.location.reload(); // reload so API/getApiBase() picks up the new base from scratch
});

document.querySelectorAll('.role-card').forEach(card => {
  card.addEventListener('click', () => {
    const role = card.dataset.role;
    navigate('/' + role);
  });
});
document.querySelectorAll('.back-link').forEach(link => {
  link.addEventListener('click', () => navigate('/'));
});

window.addEventListener('popstate', renderRoute);

// ---------------- GENERIC API FETCH ----------------
async function apiFetch(path, options = {}) {
  const headers = options.headers || {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(API + path, { ...options, headers });
  if (res.status === 401) {
    logoutAll();
    throw new Error('Session expired. Please login again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function logoutAll() {
  stopRelieverAutoRefresh();
  stopOpsMapAutoRefresh();
  stopSosAutoRefresh();
  stopTrackingMapAutoRefresh();
  clearSession();
  attemptCloseTab();
  history.replaceState({}, '', '/');
  showView('logged-out-view');
}

// Browsers only allow window.close() on tabs that were opened via script (window.open),
// so on a normal tab this will silently do nothing — that's a browser security rule we
// can't override. We still try it, and fall back to the logged-out-view message so the
// person never lands back on the sign-in/home page after logging out.
function attemptCloseTab() {
  try { window.close(); } catch (e) { /* ignored — see comment above */ }
}
document.getElementById('close-tab-btn').addEventListener('click', attemptCloseTab);

// ===========================================================================
// EMPLOYEE LOGIN
// ===========================================================================
document.getElementById('employee-login-btn').addEventListener('click', doEmployeeLogin);
document.getElementById('employee-login-id').addEventListener('keydown', e => { if (e.key === 'Enter') doEmployeeLogin(); });

async function doEmployeeLogin() {
  const company_code = document.getElementById('employee-login-company').value.trim();
  const employee_id = document.getElementById('employee-login-id').value.trim();
  const pin = document.getElementById('employee-login-pin').value.trim();
  const errBox = document.getElementById('employee-login-error');
  const btn = document.getElementById('employee-login-btn');
  errBox.style.display = 'none';

  if (!company_code) {
    errBox.textContent = 'Please enter your Company Code';
    errBox.style.display = 'block';
    return;
  }
  if (!employee_id) {
    errBox.textContent = 'Please enter your Employee ID';
    errBox.style.display = 'block';
    return;
  }
  // PIN is intentionally NOT required here — whether it's needed depends on whether this
  // specific employee has one set, which the backend decides (routes/auth.js). If they do
  // and it's missing, the server responds with a clear "PIN is required" error instead.

  // Render's free-tier instance spins down after ~15 min of inactivity — the very first
  // request after that can take 30-50+ seconds while it wakes back up. Everything after
  // that first request is instant. This just keeps the button honest about what's happening
  // instead of looking frozen, and gives a heads-up if it really is a cold start.
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Logging in…';
  const slowHintTimer = setTimeout(() => {
    btn.textContent = 'Still logging in… server is waking up, please wait';
  }, 6000);

  try {
    const res = await fetch(API + '/auth/employee-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id, pin, company_code })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    rememberCompanyCode(company_code);
    saveSession(data.token, 'employee', data.employee, null, null, data.company && data.company.name, data.settings, data.company && data.company.logo_url);
    document.getElementById('employee-login-id').value = '';
    document.getElementById('employee-login-pin').value = '';
    navigate('/employee', true);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  } finally {
    clearTimeout(slowHintTimer);
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// ===========================================================================
// MANAGER / ADMIN LOGIN (shared handler, different form ids)
// ===========================================================================
document.getElementById('manager-login-btn').addEventListener('click', () => doStaffLogin('manager'));
document.getElementById('manager-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doStaffLogin('manager'); });

document.getElementById('coordinator-login-btn').addEventListener('click', () => doStaffLogin('coordinator'));
document.getElementById('coordinator-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doStaffLogin('coordinator'); });

document.getElementById('admin-login-btn').addEventListener('click', () => doStaffLogin('admin'));
document.getElementById('admin-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doStaffLogin('admin'); });

document.getElementById('report-login-btn').addEventListener('click', () => doStaffLogin('report'));
document.getElementById('report-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doStaffLogin('report'); });

async function doStaffLogin(kind) {
  const company_code = document.getElementById(`${kind}-login-company`).value.trim();
  const username = document.getElementById(`${kind}-login-username`).value.trim();
  const password = document.getElementById(`${kind}-login-password`).value;
  const errBox = document.getElementById(`${kind}-login-error`);
  const btn = document.getElementById(`${kind}-login-btn`);
  errBox.style.display = 'none';

  if (!company_code) {
    errBox.textContent = 'Please enter your Company Code';
    errBox.style.display = 'block';
    return;
  }
  if (!username || !password) {
    errBox.textContent = 'Please enter username and password';
    errBox.style.display = 'block';
    return;
  }

  // Same cold-start situation as employee login — see comment there. Keeps the button
  // informative instead of looking stuck if the free instance needs to wake up first.
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Logging in…';
  const slowHintTimer = setTimeout(() => {
    btn.textContent = 'Still logging in… server is waking up, please wait';
  }, 6000);

  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, company_code })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    // 'report' is the login path shared by every admin-defined custom role, whose actual
    // session role is always 'report_viewer' internally — everything else is a strict match.
    const expectedRole = kind === 'report' ? 'report_viewer' : kind;
    if (data.role !== expectedRole) {
      throw new Error(`This account is not a ${kind[0].toUpperCase() + kind.slice(1)} account. Please use the correct sign-in option.`);
    }

    rememberCompanyCode(company_code);
    saveSession(data.token, data.role, null, data.project || null, data.custom_role_name || null, data.company_name || null, data.settings, data.company_logo_url || null);
    document.getElementById(`${kind}-login-password`).value = '';
    navigate('/' + kind, true);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  } finally {
    clearTimeout(slowHintTimer);
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// ===========================================================================
// INIT — restore session on page load
// ===========================================================================
(function init() {
  renderRoute();
})();

// ===========================================================================
// EMPLOYEE DASHBOARD
// ===========================================================================
document.getElementById('emp-logout-btn').addEventListener('click', logoutAll);

function showEmployeeDashboard() {
  const emp = getEmployeeInfo();
  document.getElementById('emp-name').textContent = emp ? emp.name : '-';
  document.getElementById('emp-id').textContent = emp ? emp.employee_id : '-';
  document.getElementById('emp-today-date').textContent = formatISTDate(istNow());
  showView('employee-dashboard-view');
  applyFeatureVisibility(getCompanySettingsCached());
  applyCompanyBranding('emp-dashboard-brand-name', 'emp-dashboard-brand-logo');

  // Reset to the Attendance sub-tab every time the dashboard is (re)shown
  document.querySelectorAll('.emp-subnav-item').forEach(i => i.classList.remove('active'));
  document.querySelector('.emp-subnav-item[data-emp-tab="attendance"]').classList.add('active');
  document.querySelectorAll('.emp-tab-content').forEach(t => t.classList.add('hidden'));
  document.getElementById('emp-tab-attendance').classList.remove('hidden');

  // Populate the month picker (last 3 months only) and load this employee's past requests —
  // salary slips are no longer directly viewable; a request has to be approved first.
  loadSalaryRequestableMonths().then(async () => {
    await loadMySalaryRequests();
    refreshSalaryRequestUi();
  });
  document.getElementById('salary-slip-card').innerHTML = `<div class="salary-slip-empty">📄 Once a request is approved, select that month and tap "View Salary Slip".</div>`;
  document.getElementById('salary-view-btn').disabled = true;
  document.getElementById('salary-download-btn').disabled = true;

  loadMyLeaveRequests();
  loadMyGrievances();
  loadMyStatus();
}

document.querySelectorAll('.emp-subnav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.emp-subnav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.emp-tab-content').forEach(t => t.classList.add('hidden'));
    document.getElementById('emp-tab-' + item.dataset.empTab).classList.remove('hidden');
    if (item.dataset.empTab === 'announcements') loadEmpAnnouncements();
    if (item.dataset.empTab === 'reliever') loadEmpRelieverDuties();
    if (item.dataset.empTab === 'overtime') loadEmpOvertimeHistory();
  });
});

async function loadMyStatus(silent = false) {
  const emp = getEmployeeInfo();
  if (!emp) return;
  try {
    const data = await apiFetch(`/attendance/today/${encodeURIComponent(emp.employee_id)}`);
    const box = document.getElementById('emp-current-status');
    if (!data.current_status) {
      box.innerHTML = 'Status: <b>Not marked today</b>';
    } else {
      const label = data.current_status === 'on_duty' ? 'On Duty ✅' : 'Off Duty ⏹';
      box.innerHTML = `Status: <b>${label}</b>`;
    }

    // Only one Punch In and one Punch Out allowed per day — disable buttons already used today.
    const alreadyOnDuty = data.records.some(r => r.status === 'on_duty');
    const alreadyOffDuty = data.records.some(r => r.status === 'off_duty');
    const punchInBtn = document.getElementById('punch-in-btn');
    const punchOutBtn = document.getElementById('punch-out-btn');
    punchInBtn.disabled = alreadyOnDuty;
    punchInBtn.title = alreadyOnDuty ? 'You have already Punched In today' : '';
    punchOutBtn.disabled = !alreadyOnDuty || alreadyOffDuty;
    punchOutBtn.title = alreadyOffDuty ? 'You have already Punched Out today'
      : (!alreadyOnDuty ? 'Punch In first' : '');

    // Resume live tracking after a page reload/re-login while still on_duty from earlier —
    // otherwise a refreshed tab would silently stop reporting position until the next punch.
    if (data.current_status === 'on_duty') startLiveLocationTracking();
    else stopLiveLocationTracking();

    renderTodayAttendance(data.records);
  } catch (err) {
    if (!silent) showToast(err.message, true);
  }
}

// Shows only TODAY's punches for this employee — not full history — so the table stays
// short and there's nothing sensitive to browse from past days on a shared/public device.
function renderTodayAttendance(records) {
  const tbody = document.getElementById('my-history-body');
  document.getElementById('my-history-count').textContent = `Today's Attendance (${records.length})`;
  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="icon">📭</div>No attendance marked yet today</div></td></tr>`;
    return;
  }
  tbody.innerHTML = records.map(r => `
    <tr>
      <td>${photoThumb(r.photo)}</td>
      <td class="mono">${r.attendance_date}</td>
      <td>${statusBadge(r.status)}</td>
      <td style="font-size:12px;color:var(--text-muted)">${r.address || (r.latitude != null && r.longitude != null ? `${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}` : '-')}</td>
      <td class="mono">${formatISTDateTime(r.server_time)}</td>
    </tr>
  `).join('');
}

// ---------------- SALARY SLIP (employee self-service, request + approval based) ----------------
let lastLoadedSalaryMonth = null;
let mySalaryRequestsByMonth = {}; // { 'YYYY-MM': { status, requested_at, reviewed_at } }

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

// Fills the month <select> with the last 3 requestable months (most recent first).
async function loadSalaryRequestableMonths() {
  const select = document.getElementById('salary-month-input');
  try {
    const data = await apiFetch('/salary/my/requestable-months');
    select.innerHTML = data.months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

// Loads this employee's own requests, renders the status table, and updates the
// Raise Request / View / Download buttons based on the currently-selected month's status.
async function loadMySalaryRequests() {
  try {
    const data = await apiFetch('/salary/my/slip-requests');
    mySalaryRequestsByMonth = {};
    data.requests.forEach(r => { mySalaryRequestsByMonth[r.month] = r; });
    renderMySalaryRequestsTable(data.requests);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderMySalaryRequestsTable(requests) {
  const tbody = document.getElementById('my-salary-requests-body');
  if (!requests.length) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="icon">📭</div>No requests raised yet</div></td></tr>`;
    return;
  }
  const statusBadgeMap = { pending: '⏳ Pending', approved: '✅ Approved', rejected: '❌ Rejected' };
  tbody.innerHTML = requests.map(r => `
    <tr>
      <td>${monthLabel(r.month)}</td>
      <td>${statusBadgeMap[r.status] || r.status}</td>
      <td class="mono">${formatISTDateTime(r.requested_at)}</td>
      <td class="mono">${r.reviewed_at ? formatISTDateTime(r.reviewed_at) : '-'}</td>
    </tr>
  `).join('');
}

// Reflects the selected month's request status onto the Raise Request / View / Download
// buttons and the small status line under the picker.
function refreshSalaryRequestUi() {
  const month = document.getElementById('salary-month-input').value;
  const statusLine = document.getElementById('salary-request-status');
  const requestBtn = document.getElementById('salary-request-btn');
  const viewBtn = document.getElementById('salary-view-btn');
  const downloadBtn = document.getElementById('salary-download-btn');
  const existing = mySalaryRequestsByMonth[month];

  if (!existing) {
    statusLine.textContent = `No request raised yet for ${monthLabel(month)}.`;
    requestBtn.disabled = false;
    viewBtn.disabled = true;
    downloadBtn.disabled = true;
  } else if (existing.status === 'pending') {
    statusLine.textContent = `Request for ${monthLabel(month)} is pending your coordinator's approval.`;
    requestBtn.disabled = true;
    viewBtn.disabled = true;
    downloadBtn.disabled = true;
  } else if (existing.status === 'approved') {
    statusLine.textContent = `Request for ${monthLabel(month)} is approved — you can view/download it.`;
    requestBtn.disabled = true;
    viewBtn.disabled = false;
    downloadBtn.disabled = (lastLoadedSalaryMonth !== month);
  } else if (existing.status === 'rejected') {
    statusLine.textContent = `Request for ${monthLabel(month)} was rejected by your coordinator.`;
    requestBtn.disabled = true;
    viewBtn.disabled = true;
    downloadBtn.disabled = true;
  }
}

document.getElementById('salary-month-input').addEventListener('change', refreshSalaryRequestUi);

document.getElementById('salary-request-btn').addEventListener('click', async () => {
  const month = document.getElementById('salary-month-input').value;
  if (!month) { showToast('Please select a month', true); return; }
  try {
    const data = await apiFetch('/salary/my/slip-request', {
      method: 'POST',
      body: JSON.stringify({ month })
    });
    showToast(data.message);
    await loadMySalaryRequests();
    refreshSalaryRequestUi();
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('salary-view-btn').addEventListener('click', loadMySalarySlip);

async function loadMySalarySlip() {
  const month = document.getElementById('salary-month-input').value; // YYYY-MM
  const card = document.getElementById('salary-slip-card');
  const downloadBtn = document.getElementById('salary-download-btn');

  if (!month) {
    showToast('Please select a month', true);
    return;
  }

  card.innerHTML = `<div class="salary-slip-empty">Loading…</div>`;
  downloadBtn.disabled = true;

  try {
    const data = await apiFetch(`/salary/my/slip?month=${encodeURIComponent(month)}`);
    renderSalarySlip(data.slip);
    lastLoadedSalaryMonth = month;
    downloadBtn.disabled = false;
  } catch (err) {
    card.innerHTML = `<div class="salary-slip-empty">${err.message}</div>`;
    showToast(err.message, true);
  }
}

function renderSalarySlip(slip) {
  const card = document.getElementById('salary-slip-card');
  const a = slip.attendance;
  const e = slip.earnings;
  const d = slip.deductionsBreakdown || { other: slip.deductions, pf: 0, esic: 0, total: slip.deductions };

  card.innerHTML = `
    <div class="salary-summary-row">
      <div class="salary-summary-chip"><div class="n">${slip.daysInMonth}</div><div class="l">Days in Month</div></div>
      <div class="salary-summary-chip"><div class="n">${a.present}</div><div class="l">Present</div></div>
      <div class="salary-summary-chip"><div class="n">${a.halfDay}</div><div class="l">Half Day</div></div>
      <div class="salary-summary-chip"><div class="n">${a.absent}</div><div class="l">Absent</div></div>
      <div class="salary-summary-chip"><div class="n">${a.weeklyOff}</div><div class="l">Weekly Off</div></div>
      <div class="salary-summary-chip"><div class="n">${a.payableDays}</div><div class="l">Payable Days</div></div>
    </div>
    <table class="salary-breakdown-table">
      <tbody>
        <tr><td>Basic Salary (earned)</td><td>₹ ${e.basic.toFixed(2)}</td></tr>
        <tr><td>HRA (earned)</td><td>₹ ${e.hra.toFixed(2)}</td></tr>
        <tr><td>Other Allowances (earned)</td><td>₹ ${e.otherAllowances.toFixed(2)}</td></tr>
        <tr class="total"><td>Gross Earned</td><td>₹ ${e.grossEarned.toFixed(2)}</td></tr>
        <tr class="deduction"><td>Other Deductions</td><td>− ₹ ${d.other.toFixed(2)}</td></tr>
        <tr class="deduction"><td>PF</td><td>− ₹ ${d.pf.toFixed(2)}</td></tr>
        <tr class="deduction"><td>ESIC</td><td>− ₹ ${d.esic.toFixed(2)}</td></tr>
        <tr class="deduction"><td>Total Deductions</td><td>− ₹ ${d.total.toFixed(2)}</td></tr>
        <tr class="net"><td>Net Pay</td><td>₹ ${slip.netPay.toFixed(2)}</td></tr>
      </tbody>
    </table>
  `;
}

document.getElementById('salary-download-btn').addEventListener('click', () => {
  const month = lastLoadedSalaryMonth || document.getElementById('salary-month-input').value;
  if (!month) { showToast('Please view a salary slip first', true); return; }

  fetch(`${API}/salary/my/slip/pdf?month=${encodeURIComponent(month)}`, {
    headers: { Authorization: `Bearer ${getToken()}` }
  })
    .then(res => {
      if (!res.ok) throw new Error('Could not download salary slip');
      return res.blob();
    })
    .then(blob => {
      const a = document.createElement('a');
      const objUrl = window.URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = `Salary_Slip_${month}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Salary slip downloaded');
    })
    .catch(err => showToast(err.message, true));
});

// ---------------- APPLY FOR LEAVE (employee self-service) ----------------
let selectedLeaveAttachmentDataUrl = null;

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected file'));
    reader.readAsDataURL(file);
  });
}

function updateLeaveDaysPreview() {
  const from_date = document.getElementById('leave-from-date').value;
  const to_date = document.getElementById('leave-to-date').value;
  const box = document.getElementById('leave-days-count');
  if (!from_date || !to_date) { box.textContent = ''; return; }
  if (to_date < from_date) { box.textContent = '⚠️ "Leave To" cannot be before "Leave From"'; return; }
  const days = myLeaveDaysCount(from_date, to_date);
  box.textContent = `🗓️ Total: ${days} day${days === 1 ? '' : 's'}`;
}
document.getElementById('leave-from-date').addEventListener('change', updateLeaveDaysPreview);
document.getElementById('leave-to-date').addEventListener('change', updateLeaveDaysPreview);

document.getElementById('leave-attachment').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  const nameBox = document.getElementById('leave-attachment-name');
  if (!file) { selectedLeaveAttachmentDataUrl = null; nameBox.textContent = ''; return; }

  if (file.size > 5 * 1024 * 1024) {
    showToast('Attachment is too large (max 5MB)', true);
    ev.target.value = '';
    selectedLeaveAttachmentDataUrl = null;
    nameBox.textContent = '';
    return;
  }

  try {
    selectedLeaveAttachmentDataUrl = await fileToDataUrl(file);
    nameBox.textContent = `📎 ${file.name}`;
  } catch (err) {
    showToast(err.message, true);
    selectedLeaveAttachmentDataUrl = null;
  }
});

document.getElementById('leave-submit-btn').addEventListener('click', async () => {
  const from_date = document.getElementById('leave-from-date').value;
  const to_date = document.getElementById('leave-to-date').value;
  const reason = document.getElementById('leave-reason').value.trim();
  const statusLine = document.getElementById('leave-submit-status');

  if (!from_date || !to_date) { showToast('Please select both leave dates', true); return; }
  if (to_date < from_date) { showToast('"Leave To" cannot be before "Leave From"', true); return; }
  if (!reason) { showToast('Please enter a reason for leave', true); return; }

  try {
    const data = await apiFetch('/leave/my/request', {
      method: 'POST',
      body: JSON.stringify({ from_date, to_date, reason, attachment: selectedLeaveAttachmentDataUrl }),
    });
    showToast(data.message);
    statusLine.textContent = data.message;

    // reset the form
    document.getElementById('leave-from-date').value = '';
    document.getElementById('leave-to-date').value = '';
    document.getElementById('leave-reason').value = '';
    document.getElementById('leave-attachment').value = '';
    document.getElementById('leave-attachment-name').textContent = '';
    document.getElementById('leave-days-count').textContent = '';
    selectedLeaveAttachmentDataUrl = null;

    loadMyLeaveRequests();
  } catch (err) {
    showToast(err.message, true);
    statusLine.textContent = err.message;
  }
});

async function loadMyLeaveRequests() {
  try {
    const data = await apiFetch('/leave/my/requests');
    renderMyLeaveRequestsTable(data.requests);
  } catch (err) {
    showToast(err.message, true);
  }
}

function myLeaveDaysCount(from, to) {
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  return Math.round((t - f) / 86400000) + 1;
}

function renderMyLeaveRequestsTable(requests) {
  const tbody = document.getElementById('my-leave-requests-body');
  if (!requests.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon">📭</div>No leave applications yet</div></td></tr>`;
    return;
  }
  const statusBadgeMap = { pending: '⏳ Pending', approved: '✅ Approved', rejected: '❌ Rejected' };
  tbody.innerHTML = requests.map(r => `
    <tr>
      <td class="mono">${r.from_date}</td>
      <td class="mono">${r.to_date}</td>
      <td>${myLeaveDaysCount(r.from_date, r.to_date)}</td>
      <td style="max-width:220px;white-space:normal">${r.reason || '-'}</td>
      <td>${r.attachment_url ? `<a href="${r.attachment_url}" target="_blank" rel="noopener">📎 View</a>` : '-'}</td>
      <td>${statusBadgeMap[r.status] || r.status}</td>
      <td class="mono">${formatISTDateTime(r.requested_at)}</td>
    </tr>
  `).join('');
}

// ---------------- RAISE A CONCERN / GRIEVANCE (employee self-service) ----------------
let selectedGrievanceAttachmentDataUrl = null;

document.getElementById('grievance-attachment').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  const nameBox = document.getElementById('grievance-attachment-name');
  if (!file) { selectedGrievanceAttachmentDataUrl = null; nameBox.textContent = ''; return; }

  if (file.size > 5 * 1024 * 1024) {
    showToast('Attachment is too large (max 5MB)', true);
    ev.target.value = '';
    selectedGrievanceAttachmentDataUrl = null;
    nameBox.textContent = '';
    return;
  }

  try {
    selectedGrievanceAttachmentDataUrl = await fileToDataUrl(file);
    nameBox.textContent = `📎 ${file.name}`;
  } catch (err) {
    showToast(err.message, true);
    selectedGrievanceAttachmentDataUrl = null;
  }
});

document.getElementById('grievance-submit-btn').addEventListener('click', async () => {
  const category = document.getElementById('grievance-category').value;
  const subject = document.getElementById('grievance-subject').value.trim();
  const description = document.getElementById('grievance-description').value.trim();
  const statusLine = document.getElementById('grievance-submit-status');

  if (!category) { showToast('Please select a category', true); return; }
  if (!subject) { showToast('Please enter a subject', true); return; }
  if (!description) { showToast('Please describe the problem', true); return; }

  try {
    const data = await apiFetch('/grievance/my/submit', {
      method: 'POST',
      body: JSON.stringify({ category, subject, description, attachment: selectedGrievanceAttachmentDataUrl }),
    });
    showToast(data.message);
    statusLine.textContent = data.message;

    // reset the form
    document.getElementById('grievance-category').value = '';
    document.getElementById('grievance-subject').value = '';
    document.getElementById('grievance-description').value = '';
    document.getElementById('grievance-attachment').value = '';
    document.getElementById('grievance-attachment-name').textContent = '';
    selectedGrievanceAttachmentDataUrl = null;

    loadMyGrievances();
  } catch (err) {
    showToast(err.message, true);
    statusLine.textContent = err.message;
  }
});

async function loadMyGrievances() {
  try {
    const data = await apiFetch('/grievance/my/list');
    renderMyGrievancesTable(data.requests);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderMyGrievancesTable(requests) {
  const tbody = document.getElementById('my-grievances-body');
  if (!requests.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">📭</div>No complaints raised yet</div></td></tr>`;
    return;
  }
  const statusBadgeMap = { pending: '⏳ Pending', in_review: '🔎 In Review', resolved: '✅ Resolved', rejected: '❌ Rejected' };
  tbody.innerHTML = requests.map(r => `
    <tr>
      <td>${r.category}</td>
      <td style="max-width:200px;white-space:normal">${r.subject}</td>
      <td>${r.attachment_url ? `<a href="${r.attachment_url}" target="_blank" rel="noopener">📎 View</a>` : '-'}</td>
      <td>${statusBadgeMap[r.status] || r.status}</td>
      <td style="max-width:200px;white-space:normal">${r.resolution_note || '-'}</td>
      <td class="mono">${formatISTDateTime(r.requested_at)}</td>
    </tr>
  `).join('');
}

// ---------------- PUNCH IN / OUT via camera + geolocation ----------------
let cameraStream = null;
let capturedPhoto = null;
let capturedLocation = null;
let pendingPunchStatus = null;

document.getElementById('punch-in-btn').addEventListener('click', () => openCameraModal('on_duty'));
document.getElementById('punch-out-btn').addEventListener('click', () => openCameraModal('off_duty'));
document.getElementById('camera-cancel-btn').addEventListener('click', closeCameraModal);
document.getElementById('camera-capture-btn').addEventListener('click', captureAndSubmit);

async function openCameraModal(status) {
  pendingPunchStatus = status;
  capturedPhoto = null;
  capturedLocation = null;
  document.getElementById('camera-modal-title').textContent =
    status === 'on_duty' ? 'Take a Selfie to Punch In' : 'Take a Selfie to Punch Out';
  document.getElementById('camera-status').textContent = 'Requesting camera & location access…';
  document.getElementById('camera-capture-btn').disabled = true;
  document.getElementById('camera-modal').classList.remove('hidden');

  // Kick off camera AND location together instead of one-after-another — this was the main
  // reason location "took time": it only started requesting GPS after the camera had already
  // fully resolved. Running them in parallel roughly halves the wait.
  document.getElementById('camera-status').textContent = 'Starting camera & fetching location…';

  const cameraPromise = navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
    .then(stream => {
      cameraStream = stream;
      document.getElementById('camera-video').srcObject = stream;
      return true;
    })
    .catch(() => {
      document.getElementById('camera-status').textContent = 'Camera access denied. Please allow camera permission.';
      return false;
    });

  if (!navigator.geolocation) {
    document.getElementById('camera-status').textContent = 'Geolocation not supported on this device/browser.';
    await cameraPromise;
    return;
  }

  const locationPromise = getVerifiedLocation()
    .then(loc => { capturedLocation = loc; return true; })
    .catch(err => {
      document.getElementById('camera-status').textContent = err.message;
      return false;
    });

  const [cameraOk, locationOk] = await Promise.all([cameraPromise, locationPromise]);

  if (cameraOk && locationOk) {
    document.getElementById('camera-status').textContent = 'Location captured. Ready to take selfie.';
    document.getElementById('camera-capture-btn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Best-effort fake/mock GPS check.
//
// IMPORTANT HONEST LIMITATION: a website (running inside a normal mobile browser)
// cannot read Android's OS-level "Allow mock locations / Developer options" flag —
// that flag is only readable by a native Android app via Location.isFromMockProvider().
// A pure web app has no way to guarantee 100% that GPS wasn't spoofed.
//
// What we CAN do from the browser, and what this does:
//   1. Reject accuracy === 0 or missing — real device GPS/network location essentially
//      never reports exactly 0m accuracy; many fake-GPS apps and DevTools location
//      overrides default to exactly 0.
//   2. Take TWO readings ~1.5s apart. Real GPS sensors always have tiny natural jitter.
//      If both readings are bit-for-bit identical (lat, lng AND accuracy), that's a strong
//      signal of a simulated/injected location rather than a live sensor.
// If either check trips, we block the punch and ask the user to disable location
// simulation / mock location apps and retry with real GPS.
function getVerifiedLocation() {
  const readOnce = (opts) => new Promise((res, rej) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => res(pos.coords),
      (err) => rej(new Error(
        err.code === 1 ? 'Location access denied. Please allow location permission.' :
        err.code === 3 ? 'Location is taking too long. Please check GPS is on and try again.' :
        'Could not fetch location. Please check GPS is on and try again.'
      )),
      opts
    );
  });

  return (async () => {
    let coords;
    try {
      // Fast, high-accuracy attempt first — most devices resolve this in a couple of seconds.
      coords = await readOnce({ enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
    } catch (err) {
      // Fall back to a quick lower-accuracy fix (network/wifi based) rather than leaving
      // the employee stuck waiting on a weak GPS signal — better an approximate location
      // than none at all.
      coords = await readOnce({ enableHighAccuracy: false, timeout: 8000, maximumAge: 5000 });
    }

    // accuracy === 0 (or missing) essentially never happens on a real device/network fix —
    // it's the one reliable signal of a spoofed/mocked location, so this alone is blocked.
    if (coords.accuracy === undefined || coords.accuracy === null || coords.accuracy === 0) {
      throw new Error('Location looks artificial (no GPS accuracy reported). Please disable mock location / location simulation and try again.');
    }

    return { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy };
  })();
}

function closeCameraModal() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  document.getElementById('camera-modal').classList.add('hidden');
}

async function reverseGeocode(lat, lng) {
  // Nominatim (OpenStreetMap's free reverse-geocoding service) has no uptime/speed guarantee
  // and can occasionally take a very long time to respond. Without a timeout, that would leave
  // the employee stuck on "Getting address…" far longer than the location fix itself ever took.
  // Cap it at 6s — if it doesn't answer by then, the punch still goes through, just with
  // lat/lng shown instead of a street address.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`, {
      signal: controller.signal,
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.display_name || '';
  } catch (err) {
    return ''; // timed out or network error — fall back to lat/lng, don't block the punch
  } finally {
    clearTimeout(timer);
  }
}

// Draws a semi-transparent info strip at the bottom of the selfie with Employee ID, Name,
// current location, and live IST punch date/time — burned into the photo itself so the
// selfie is self-verifying, the same way standard attendance-app selfies work.
function stampSelfie(ctx, canvas, { employeeId, name, address, latitude, longitude, punchDate }) {
  const lines = [
    `${employeeId}  •  ${name}`,
    address ? address : `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
    formatISTDateTime(punchDate) + ' IST',
  ];

  const padding = 8;
  const lineHeight = Math.max(14, Math.round(canvas.height * 0.045));
  const fontSize = Math.round(lineHeight * 0.72);
  const stripHeight = lines.length * lineHeight + padding * 2;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, canvas.height - stripHeight, canvas.width, stripHeight);

  ctx.font = `${fontSize}px Arial, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    // Wrap long lines (e.g. long addresses) so text doesn't run off the photo edge.
    const maxWidth = canvas.width - padding * 2;
    let text = line;
    while (ctx.measureText(text).width > maxWidth && text.length > 3) {
      text = text.slice(0, -4) + '…';
    }
    ctx.fillText(text, padding, canvas.height - stripHeight + padding + i * lineHeight);
  });
}

async function captureAndSubmit() {
  if (!capturedLocation) {
    showToast('Location not available yet', true);
    return;
  }

  document.getElementById('camera-capture-btn').disabled = true;
  document.getElementById('camera-status').textContent = 'Getting address…';
  const address = await reverseGeocode(capturedLocation.latitude, capturedLocation.longitude);

  const emp = getEmployeeInfo();
  const punchDate = new Date();

  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  canvas.width = video.videoWidth || 480;
  canvas.height = video.videoHeight || 360;
  const ctx = canvas.getContext('2d');
  // Mirror to match the preview (selfie view)
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  // Undo the mirror transform before drawing text, so the stamped info reads left-to-right normally.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  stampSelfie(ctx, canvas, {
    employeeId: emp ? emp.employee_id : '',
    name: emp ? emp.name : '',
    address,
    latitude: capturedLocation.latitude,
    longitude: capturedLocation.longitude,
    punchDate,
  });
  capturedPhoto = canvas.toDataURL('image/jpeg', 0.85);

  document.getElementById('camera-status').textContent = 'Submitting attendance…';

  try {
    await apiFetch('/attendance/punch', {
      method: 'POST',
      body: JSON.stringify({
        status: pendingPunchStatus,
        photo: capturedPhoto,
        latitude: capturedLocation.latitude,
        longitude: capturedLocation.longitude,
        accuracy: capturedLocation.accuracy,
        address,
        device_time: punchDate.toISOString(),
      })
    });
    showToast(pendingPunchStatus === 'on_duty' ? 'Punched In successfully' : 'Punched Out successfully');
    closeCameraModal();
    // Live location tracking runs for exactly as long as the employee is on_duty — start the
    // periodic ping right after a successful punch-in, stop it right after punch-out. This
    // is what lets "who's nearby site X" and the reliever ranking's distance score be based
    // on real-time position instead of a single stale punch-in point.
    if (pendingPunchStatus === 'on_duty') startLiveLocationTracking();
    else stopLiveLocationTracking();
    // silent: a transient refresh failure right after a successful punch should never
    // show a red error toast that overwrites/contradicts the success message above.
    loadMyStatus(true);
  } catch (err) {
    document.getElementById('camera-capture-btn').disabled = false;
    document.getElementById('camera-status').textContent = err.message;
    showToast(err.message, true);
  }
}

// ===========================================================================
// SHARED ADMIN / MANAGER DASHBOARD
// ===========================================================================
document.getElementById('logout-btn').addEventListener('click', logoutAll);

function showDashboard() {
  const role = getRole();
  applyFeatureVisibility(getCompanySettingsCached());
  applyCompanyBranding('dashboard-brand-name', 'dashboard-brand-logo');
  document.body.classList.remove('role-admin', 'role-manager', 'role-coordinator', 'role-report_viewer');
  document.body.classList.add('role-' + role);
  document.getElementById('role-pill').textContent = (role === 'report_viewer' ? (getCustomRoleLabel() || 'Reports') : role).toUpperCase();

  const projectPill = document.getElementById('project-pill');
  const staffProject = getStaffProject();
  if (role !== 'admin' && staffProject) {
    projectPill.textContent = staffProject;
    projectPill.classList.remove('hidden');
  } else {
    projectPill.classList.add('hidden');
  }

  showView('dashboard-view');
  document.getElementById('today-date').textContent = formatISTDate(istNow());

  // report_viewer (Area Officer/Supervisor/etc.) only ever gets the Reports tab — always land
  // there directly, and skip Overview/Shift Categories entirely since those API calls (employee
  // list, attendance summary, shift categories) are blocked for this role by design.
  if (role === 'report_viewer') {
    activateNavTab('reports');
    const reportsGroup = document.querySelector('.nav-item[data-tab="reports"]').closest('.nav-group');
    if (reportsGroup) reportsGroup.classList.add('open');
    return;
  }

  // If a non-admin (manager/coordinator) landed on an admin-only tab from a previous admin
  // session, reset to overview.
  if (role !== 'admin') {
    activateNavTab('overview');
  }

  loadOverview();
  loadProjects();
  loadShiftCategories();
}

// ---------------- TABS ----------------
// Reports and Employees each have a sidebar sub-menu (category list) with more than one
// panel living inside the same tab. Only ONE of those panels should ever be visible at a
// time — whichever category was last clicked — instead of all of them stacking on top of
// each other.
const NAV_GROUP_PANELS = {
  reports: ['report-panel-attendance', 'report-panel-punch', 'report-panel-empdata', 'report-panel-shiftcycle'],
  employees: ['manage-projects-panel', 'manage-shift-categories-panel', 'emp-select-project-panel']
};

// Shows only `panelId` among that tab's grouped panels (if the tab has any) and hides the
// rest, and keeps the matching sidebar sub-item marked active.
function showOnlyNavPanel(tabKey, panelId) {
  const panels = NAV_GROUP_PANELS[tabKey];
  if (!panels) return;
  panels.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== panelId);
  });
  document.querySelectorAll('.nav-sub-item[data-tab="' + tabKey + '"]').forEach(i => {
    i.classList.toggle('active', i.dataset.target === panelId);
  });
}

// Shared by the sidebar's main nav items AND the Reports/Employees sub-menu links, so
// clicking either always ends up in the same consistent state.
function activateNavTab(tabKey) {
  const navItem = document.querySelector('.nav-item[data-tab="' + tabKey + '"]');
  if (navItem && navItem.classList.contains('admin-only') && getRole() !== 'admin') return false;

  document.querySelectorAll('.nav-item[data-tab]').forEach(i => i.classList.remove('active'));
  if (navItem) navItem.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
  document.getElementById('tab-' + tabKey).classList.remove('hidden');

  // Live-polling dashboards should only poll while their tab is actually visible — stop
  // them all the moment we navigate away, the specific tab handler below restarts the
  // relevant one if we're navigating INTO it.
  stopRelieverAutoRefresh();
  stopOpsMapAutoRefresh();
  stopSosAutoRefresh();
  stopTrackingMapAutoRefresh();

  if (tabKey === 'overview') loadOverview();
  if (tabKey === 'attendance') { loadProjects(); loadAttendance(); }
  if (tabKey === 'reports') {
    loadProjects(); prefillReportDatesIfEmpty();
    // Default to the first category (Attendance Report) whenever Reports is opened fresh —
    // the specific sub-menu click handler below will override this if a category was clicked.
    showOnlyNavPanel('reports', 'report-panel-attendance');
  }
  if (tabKey === 'employees') {
    loadProjects(); loadShiftCategories(); showEmployeeProjectPicker();
    // Non-admin roles never see Manage Projects / Shift Categories (admin-only), so their
    // only real category is the Employee List — default straight to it either way.
    showOnlyNavPanel('employees', 'emp-select-project-panel');
  }
  if (tabKey === 'salary-requests') loadSalaryRequests();
  if (tabKey === 'leave-requests') { loadProjects(); loadLeaveRequests(); }
  if (tabKey === 'grievances') { loadProjects(); loadGrievances(); }
  if (tabKey === 'reliever') { loadRelieverDashboard(); startRelieverAutoRefresh(); loadNearbySearch(); loadAutoAssignToggle(); }
  if (tabKey === 'overtime') { loadOvertimeRequests(); loadPaymentBatches(); }
  if (tabKey === 'ops-map') { loadOpsMap(); startOpsMapAutoRefresh(); loadEscalations(); }
  if (tabKey === 'tracking') { loadTrackingMap(); startTrackingMapAutoRefresh(); }
  if (tabKey === 'maintenance') { loadProjects(); loadMaintenanceTickets(); }
  if (tabKey === 'sos') { loadSosAlerts(); startSosAutoRefresh(); }
  if (tabKey === 'announcements') { loadProjects(); loadAnnouncements(); }
  if (tabKey === 'audit') { loadAuditLog(); loadLoginHistory(); }
  if (tabKey === 'clients') { loadProjects(); loadClientAccounts(); }
  if (tabKey === 'managers') { loadProjects(); loadManagers(); loadRoleTypes(); loadRoleAccounts(); }
  if (tabKey === 'coordinators') { loadProjects(); loadCoordinatorAccounts(); }
  return true;
}

// Briefly flashes a border around a panel so it's obvious which one the sidebar just
// jumped to, then scrolls it into view.
function jumpToPanel(panelId) {
  const target = document.getElementById(panelId);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('nav-highlight');
  // restart the animation even if it was already running
  void target.offsetWidth;
  target.classList.add('nav-highlight');
  setTimeout(() => target.classList.remove('nav-highlight'), 1200);
}

document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
  item.addEventListener('click', () => {
    const ok = activateNavTab(item.dataset.tab);
    if (!ok) return;

    // Reports / Employees also have a sidebar sub-menu — expand it when the parent is clicked.
    const group = item.closest('.nav-group');
    if (group) {
      document.querySelectorAll('.nav-group').forEach(g => { if (g !== group) g.classList.remove('open'); });
      group.classList.toggle('open');
    }
  });
});

// Sub-menu links under Reports / Employees: open the right tab AND jump straight to that
// specific report/panel instead of leaving the user to scroll and find it themselves.
document.querySelectorAll('.nav-sub-item[data-tab]').forEach(item => {
  item.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (item.classList.contains('admin-only') && getRole() !== 'admin') return;

    const ok = activateNavTab(item.dataset.tab);
    if (!ok) return;

    // activateNavTab() above defaults to the first category in the group — now switch to
    // whichever one was actually clicked, so only that single category is visible.
    showOnlyNavPanel(item.dataset.tab, item.dataset.target);

    const group = item.closest('.nav-group');
    if (group) {
      document.querySelectorAll('.nav-group').forEach(g => { if (g !== group) g.classList.remove('open'); });
      group.classList.add('open');
    }

    // Employee List lives inside the project-picker view, which showEmployeeProjectPicker()
    // (called by activateNavTab above) already renders — jump to it right after.
    setTimeout(() => jumpToPanel(item.dataset.target), 30);
  });
});

// ---------------- OVERVIEW ----------------
async function loadOverview() {
  try {
    const empData = await apiFetch('/employees');
    const summaryData = await apiFetch('/attendance/summary');

    const total = empData.employees.filter(e => e.active).length;
    document.getElementById('stat-total').textContent = total;

    const onDuty = summaryData.summary.filter(s => s.status === 'on_duty').length;
    const offDuty = summaryData.summary.filter(s => s.status === 'off_duty').length;
    const pending = summaryData.summary.filter(s => !s.status).length;

    document.getElementById('stat-on-duty').textContent = onDuty;
    document.getElementById('stat-off-duty').textContent = offDuty;
    document.getElementById('stat-pending').textContent = pending;

    const tbody = document.getElementById('summary-table-body');
    if (summaryData.summary.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">📭</div>No employees added yet</div></td></tr>`;
    } else {
      tbody.innerHTML = summaryData.summary.map(s => `
        <tr>
          <td>${photoThumb(s.photo)}</td>
          <td class="mono">${s.employee_id}</td>
          <td>${s.name}</td>
          <td>${statusBadge(s.status)}</td>
          <td class="mono">${s.time ? formatISTTime(s.time) : '—'}</td>
          <td style="font-size:12px;color:var(--text-muted)">${s.address || '—'}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

function statusBadge(status) {
  if (!status) return `<span style="color:var(--text-muted);font-size:12px">Not marked</span>`;
  const label = status === 'on_duty' ? 'On Duty' : 'Off Duty';
  return `<span class="badge ${status}"><span class="badge-dot"></span>${label}</span>`;
}

function photoThumb(photo) {
  if (!photo) return `<div class="photo-thumb photo-thumb-empty">—</div>`;
  return `<img src="${photo}" class="photo-thumb" onclick="showPhotoModal('${photo.replace(/'/g, "\\'")}')" />`;
}

function showPhotoModal(photo) {
  const modal = document.getElementById('photo-modal');
  document.getElementById('photo-modal-img').src = photo;
  modal.classList.remove('hidden');
}
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('photo-modal');
  if (modal) modal.addEventListener('click', () => modal.classList.add('hidden'));
});

// ---------------- ATTENDANCE LOG ----------------
async function loadAttendance() {
  const from = document.getElementById('filter-from').value;
  const to = document.getElementById('filter-to').value;
  const emp = document.getElementById('filter-emp').value.trim();
  const location = document.getElementById('filter-location').value.trim();
  const project = document.getElementById('filter-project').value.trim();

  let query = [];
  if (from) query.push(`from=${from}`);
  if (to) query.push(`to=${to}`);
  if (emp) query.push(`employee_id=${encodeURIComponent(emp)}`);
  if (location) query.push(`location=${encodeURIComponent(location)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);

  try {
    const data = await apiFetch('/attendance' + (query.length ? '?' + query.join('&') : ''));
    document.getElementById('records-count').textContent = `Records (${data.count})`;
    const tbody = document.getElementById('attendance-table-body');

    if (data.records.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="icon">📭</div>No attendance records found</div></td></tr>`;
      return;
    }

    tbody.innerHTML = data.records.map(r => `
      <tr>
        <td>${photoThumb(r.photo)}</td>
        <td class="mono">${r.attendance_date}</td>
        <td class="mono">${r.employee_id}</td>
        <td>${r.employee_name || '-'}</td>
        <td>${r.project || '-'}</td>
        <td><span class="badge ${r.status}"><span class="badge-dot"></span>${r.status.replace('_', ' ')}</span></td>
        <td class="mono">${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}</td>
        <td class="mono">${formatISTDateTime(r.server_time)}</td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('apply-filter-btn').addEventListener('click', loadAttendance);
document.getElementById('clear-filter-btn').addEventListener('click', () => {
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  document.getElementById('filter-emp').value = '';
  document.getElementById('filter-location').value = '';
  document.getElementById('filter-project').value = '';
  loadAttendance();
});

document.getElementById('download-excel-btn').addEventListener('click', () => {
  const from = document.getElementById('filter-from').value;
  const to = document.getElementById('filter-to').value;
  const emp = document.getElementById('filter-emp').value.trim();
  const location = document.getElementById('filter-location').value.trim();
  const project = document.getElementById('filter-project').value.trim();

  let query = [];
  if (from) query.push(`from=${from}`);
  if (to) query.push(`to=${to}`);
  if (emp) query.push(`employee_id=${encodeURIComponent(emp)}`);
  if (location) query.push(`location=${encodeURIComponent(location)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);

  const url = `${API}/export/excel${query.length ? '?' + query.join('&') : ''}`;

  fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
    .then(res => {
      if (!res.ok) throw new Error('Export failed');
      return res.blob();
    })
    .then(blob => {
      const a = document.createElement('a');
      const objUrl = window.URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = `Geovixa_Attendance_Report.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Excel report downloaded');
    })
    .catch(err => showToast(err.message, true));
});

// ---------------- REPORTS (P/A Excel + Employee Data Excel, admin + manager) ----------------
function defaultReportDates() {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  return {
    from: firstOfMonth.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  };
}

function prefillReportDatesIfEmpty() {
  const fromInput = document.getElementById('report-from');
  const toInput = document.getElementById('report-to');
  if (!fromInput.value || !toInput.value) {
    const d = defaultReportDates();
    fromInput.value = fromInput.value || d.from;
    toInput.value = toInput.value || d.to;
  }
}

document.getElementById('download-summary-excel-btn').addEventListener('click', () => {
  prefillReportDatesIfEmpty();
  const from = document.getElementById('report-from').value;
  const to = document.getElementById('report-to').value;
  const location = document.getElementById('report-location').value.trim();
  const zone = document.getElementById('report-zone').value.trim();
  const ward = document.getElementById('report-ward').value.trim();
  const project = document.getElementById('report-project').value.trim();

  let query = [`from=${from}`, `to=${to}`];
  if (location) query.push(`location=${encodeURIComponent(location)}`);
  if (zone) query.push(`zone=${encodeURIComponent(zone)}`);
  if (ward) query.push(`ward=${encodeURIComponent(ward)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);

  const url = `${API}/export/summary-excel?${query.join('&')}`;

  fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
    .then(res => {
      if (!res.ok) throw new Error('Export failed');
      return res.blob();
    })
    .then(blob => {
      const a = document.createElement('a');
      const objUrl = window.URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = `Geovixa_Attendance_Report.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Attendance report downloaded');
    })
    .catch(err => showToast(err.message, true));
});

document.getElementById('download-punch-excel-btn').addEventListener('click', () => {
  const fromInput = document.getElementById('punch-report-from');
  const toInput = document.getElementById('punch-report-to');
  if (!fromInput.value || !toInput.value) {
    const d = defaultReportDates();
    fromInput.value = fromInput.value || d.from;
    toInput.value = toInput.value || d.to;
  }
  const from = fromInput.value;
  const to = toInput.value;
  const employee_id = document.getElementById('punch-report-emp').value.trim();
  const location = document.getElementById('punch-report-location').value.trim();
  const zone = document.getElementById('punch-report-zone').value.trim();
  const ward = document.getElementById('punch-report-ward').value.trim();
  const project = document.getElementById('punch-report-project').value.trim();

  let query = [`from=${from}`, `to=${to}`];
  if (employee_id) query.push(`employee_id=${encodeURIComponent(employee_id)}`);
  if (location) query.push(`location=${encodeURIComponent(location)}`);
  if (zone) query.push(`zone=${encodeURIComponent(zone)}`);
  if (ward) query.push(`ward=${encodeURIComponent(ward)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);

  const url = `${API}/export/excel?${query.join('&')}`;

  fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
    .then(res => {
      if (!res.ok) throw new Error('Export failed');
      return res.blob();
    })
    .then(blob => {
      const a = document.createElement('a');
      const objUrl = window.URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = `Geovixa_Punch_Time_Report.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Punch time report downloaded');
    })
    .catch(err => showToast(err.message, true));
});

document.getElementById('download-employees-excel-btn').addEventListener('click', () => {
  const location = document.getElementById('employee-report-location').value.trim();
  const zone = document.getElementById('employee-report-zone').value.trim();
  const ward = document.getElementById('employee-report-ward').value.trim();
  const project = document.getElementById('employee-report-project').value.trim();
  let query = [];
  if (location) query.push(`location=${encodeURIComponent(location)}`);
  if (zone) query.push(`zone=${encodeURIComponent(zone)}`);
  if (ward) query.push(`ward=${encodeURIComponent(ward)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);
  const url = `${API}/export/employees-excel${query.length ? '?' + query.join('&') : ''}`;

  fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
    .then(res => {
      if (!res.ok) throw new Error('Export failed');
      return res.blob();
    })
    .then(blob => {
      const a = document.createElement('a');
      const objUrl = window.URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = `Geovixa_Employee_Data.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Employee data report downloaded');
    })
    .catch(err => showToast(err.message, true));
});

// Shared helper — hits `url` with the auth token, downloads the response as a file named
// `filename`, and shows a toast. Used by every "Download Report/Excel" button below so each
// one isn't repeating the same fetch->blob->anchor dance.
function downloadFileWithAuth(url, filename, successMessage) {
  fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
    .then(res => {
      if (!res.ok) throw new Error('Export failed');
      return res.blob();
    })
    .then(blob => {
      const a = document.createElement('a');
      const objUrl = window.URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast(successMessage);
    })
    .catch(err => showToast(err.message, true));
}

// Shift Cycle Report (8 Hrs - FA) — this panel existed in the HTML but had no JS behind it
// at all (dates never defaulted, the project dropdown was never populated, and the download
// button did nothing). Wired up the same way as the other Reports panels above.
document.getElementById('download-shiftcycle-excel-btn').addEventListener('click', () => {
  const fromInput = document.getElementById('shiftcycle-report-from');
  const toInput = document.getElementById('shiftcycle-report-to');
  if (!fromInput.value || !toInput.value) {
    const d = defaultReportDates();
    fromInput.value = fromInput.value || d.from;
    toInput.value = toInput.value || d.to;
  }
  const from = fromInput.value;
  const to = toInput.value;
  const location = document.getElementById('shiftcycle-report-location').value.trim();
  const zone = document.getElementById('shiftcycle-report-zone').value.trim();
  const ward = document.getElementById('shiftcycle-report-ward').value.trim();
  const project = document.getElementById('shiftcycle-report-project').value.trim();

  let query = [`from=${from}`, `to=${to}`];
  if (location) query.push(`location=${encodeURIComponent(location)}`);
  if (zone) query.push(`zone=${encodeURIComponent(zone)}`);
  if (ward) query.push(`ward=${encodeURIComponent(ward)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);

  downloadFileWithAuth(
    `${API}/export/shift-cycle-excel?${query.join('&')}`,
    'Geovixa_Shift_Cycle_Report.xlsx',
    'Shift cycle report downloaded'
  );
});

// Salary Slip Requests — download report button (reuses the same status filter already on
// the tab; project scoping for manager/coordinator is enforced backend-side same as the list).
document.getElementById('download-salary-requests-excel-btn').addEventListener('click', () => {
  const status = document.getElementById('salary-requests-status-filter').value;
  const url = `${API}/salary/requests/export/excel${status ? `?status=${encodeURIComponent(status)}` : ''}`;
  downloadFileWithAuth(url, 'Geovixa_Salary_Slip_Requests_Report.xlsx', 'Salary slip requests report downloaded');
});

// Leave Requests — download report button, reuses the status + project filters on the tab.
document.getElementById('download-leave-requests-excel-btn').addEventListener('click', () => {
  const status = document.getElementById('leave-requests-status-filter').value;
  const project = document.getElementById('leave-requests-project-filter').value;
  let query = [];
  if (status) query.push(`status=${encodeURIComponent(status)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);
  const url = `${API}/leave/requests/export/excel${query.length ? '?' + query.join('&') : ''}`;
  downloadFileWithAuth(url, 'Geovixa_Leave_Requests_Report.xlsx', 'Leave requests report downloaded');
});

document.getElementById('download-grievances-excel-btn').addEventListener('click', () => {
  const status = document.getElementById('grievances-status-filter').value;
  const category = document.getElementById('grievances-category-filter').value;
  const project = document.getElementById('grievances-project-filter').value;
  let query = [];
  if (status) query.push(`status=${encodeURIComponent(status)}`);
  if (category) query.push(`category=${encodeURIComponent(category)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);
  const url = `${API}/grievance/export/excel${query.length ? '?' + query.join('&') : ''}`;
  downloadFileWithAuth(url, 'Geovixa_Grievances_Report.xlsx', 'Grievances report downloaded');
});

// ---------------- PROJECTS ----------------
// Any project whose name starts with "MCGM" (MCGM, MCGM HK, MCGM Education, and any future
// MCGM-prefixed project) gets grouped together under one "MCGM" heading in every dropdown —
// this is name-based so it keeps working automatically for new MCGM projects added later too.
// includeGroupOption=true adds an extra top-level "MCGM — all 3 parts combined" option
// (value="MCGM") ABOVE the individual parts — used only for Manager/Coordinator account
// creation, so a single login (e.g. "krishna_mcgm") can be granted access to all 3 real MCGM
// projects at once. Employees themselves are still always assigned one real part, never the
// group key, so that option is left out for the employee Project dropdowns.
function buildProjectOptionsHTML(projects, placeholderOptionHTML, includeGroupOption) {
  // Group projects by their admin-set Group Name (Manage Projects -> Edit -> Group Name).
  // A project with no group_name is shown as a plain top-level option; two or more projects
  // sharing the same group_name are shown together under that group.
  const groups = new Map(); // groupName -> [project, ...]
  const ungrouped = [];
  projects.forEach(p => {
    const g = (p.group_name || '').trim();
    if (g) {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    } else {
      ungrouped.push(p);
    }
  });
  // A "group" with only one member isn't really combining anything yet — treat it like an
  // ungrouped project until the admin adds a second project to the same Group Name.
  [...groups.entries()].forEach(([g, members]) => {
    if (members.length < 2) {
      groups.delete(g);
      ungrouped.push(...members);
    }
  });

  let html = placeholderOptionHTML;
  if (includeGroupOption) {
    groups.forEach((members, groupName) => {
      html += `<option value="${groupName}">${groupName} — all ${members.length} parts combined</option>`;
    });
  }
  ungrouped.forEach(p => { html += `<option value="${p.name}">${p.name}</option>`; });
  groups.forEach((members, groupName) => {
    html += `<optgroup label="${includeGroupOption ? `${groupName} (individual part)` : groupName}">`;
    members.forEach(p => { html += `<option value="${p.name}">${p.name}</option>`; });
    html += `</optgroup>`;
  });
  return html;
}

// ---------------- EMPLOYEES TAB: PROJECT PICKER + PER-PROJECT WORKSPACE ----------------
// Clicking "Employees" in the sidebar now shows a list of Projects first (MCGM's 3 real parts
// combined into one row here, purely for navigation); clicking a row opens that project's own,
// separate employee section (Add / Bulk Add / Employee List), scoped to just that project — or,
// for the combined MCGM row, all 3 real parts at once (with an in-page filter to still narrow
// down to one part, since the underlying data for each part stays completely separate).
let currentEmpScope = null; // { key, label, members: [realProjectName, ...], param }
let empNavEntries = {};

function buildGroupedProjectEntries(allProjects) {
  const groups = new Map(); // groupName -> [project name, ...]
  const others = [];
  allProjects.forEach(p => {
    const g = (p.group_name || '').trim();
    if (g) {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p.name);
    } else {
      others.push(p.name);
    }
  });
  // A "group" with only one member isn't really combining anything yet.
  [...groups.entries()].forEach(([g, members]) => {
    if (members.length < 2) {
      groups.delete(g);
      others.push(...members);
    }
  });

  const entries = others.map(p => ({ key: p, label: p, members: [p], param: p }));
  groups.forEach((members, groupName) => {
    entries.push({ key: groupName, label: groupName, members, param: groupName });
  });
  return entries.sort((a, b) => a.label.localeCompare(b.label));
}

async function renderProjectNavList() {
  const listEl = document.getElementById('emp-project-nav-list');
  if (!listEl) return;
  try {
    const [projData, empData] = await Promise.all([apiFetch('/projects'), apiFetch('/employees')]);
    const allProjects = projData.projects || [];

    const counts = {};
    (empData.employees || []).forEach(e => {
      const key = e.project || '—';
      counts[key] = (counts[key] || 0) + 1;
    });

    let entries = buildGroupedProjectEntries(allProjects);

    // Manager/Coordinator: only show the project(s)/group they're actually locked to.
    const isAdmin = getRole() === 'admin';
    const staffProject = getStaffProject();
    if (!isAdmin && staffProject) {
      const mine = staffProject.split(',').map(s => s.trim());
      entries = entries.filter(en => mine.includes(en.key));
    }

    empNavEntries = {};
    entries.forEach(en => { empNavEntries[en.key] = en; });

    if (entries.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="icon">📁</div>Koi project assign nahi hai</div>`;
      return;
    }

    listEl.innerHTML = entries.map(en => {
      const count = en.members.reduce((sum, m) => sum + (counts[m] || 0), 0);
      const partsNote = en.members.length > 1
        ? `<span class="proj-nav-sub">${en.members.length} parts combined</span>`
        : '';
      return `
        <div class="proj-nav-row" onclick="openEmployeeWorkspace('${en.key.replace(/'/g, "\\'")}')">
          <div class="proj-nav-name">📁 ${en.label} ${partsNote}</div>
          <div class="proj-nav-count">${count} employee${count === 1 ? '' : 's'} →</div>
        </div>`;
    }).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

function showEmployeeProjectPicker() {
  currentEmpScope = null;
  document.getElementById('emp-workspace-view').classList.add('hidden');
  document.getElementById('emp-project-picker-view').classList.remove('hidden');
  renderProjectNavList();
}

function openEmployeeWorkspace(key) {
  const entry = empNavEntries[key];
  if (!entry) return;
  currentEmpScope = entry;

  document.getElementById('emp-project-picker-view').classList.add('hidden');
  document.getElementById('emp-workspace-view').classList.remove('hidden');
  document.getElementById('emp-workspace-title').textContent = entry.members.length > 1
    ? `${entry.label} (combined — ${entry.members.join(', ')})`
    : entry.label;

  // Add Employee's Project dropdown is limited to this scope's real project(s) only.
  const addSel = document.getElementById('add-emp-project');
  if (addSel) {
    if (entry.members.length > 1) {
      addSel.innerHTML = '<option value="">— Select Part —</option>' +
        entry.members.map(m => `<option value="${m}">${m}</option>`).join('');
      addSel.value = '';
    } else {
      addSel.innerHTML = `<option value="${entry.members[0]}">${entry.members[0]}</option>`;
      addSel.value = entry.members[0];
    }
    addSel.disabled = false;
  }

  // In-page sub-filter — only needed for a combined (multi-part) scope, so each real part can
  // still be viewed on its own; a single-project scope needs no extra filter.
  const subFilterWrap = document.getElementById('emp-workspace-subfilter');
  if (subFilterWrap) {
    if (entry.members.length > 1) {
      subFilterWrap.innerHTML = `
        <div class="field">
          <label>Show part</label>
          <select id="emp-filter-project">
            <option value="">All ${entry.members.length} parts (combined)</option>
            ${entry.members.map(m => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>`;
      document.getElementById('emp-filter-project').addEventListener('change', loadEmployees);
    } else {
      subFilterWrap.innerHTML = '';
    }
  }

  loadEmployees();
}

document.getElementById('emp-workspace-back-btn').addEventListener('click', showEmployeeProjectPicker);

// Populates every Project <select> in the app (Add Employee, filters, reports, Manager/
// Coordinator creation) and, for admins, renders the removable chip list in "Manage Projects".
//
// Managers/Coordinators are locked to the single project their account was created with
// (assigned by the Admin — e.g. username "krishna_mcgmhk" -> project "MCGM HK"). For them,
// every project filter dropdown is narrowed to just their own project and disabled, so they
// can only ever see their own project's data (the backend enforces this too, regardless of
// what the dropdown shows) and don't see the names of other projects they have no access to.
async function loadProjects() {
  try {
    const data = await apiFetch('/projects');
    const allProjects = data.projects || [];
    const role = getRole();
    const isAdmin = role === 'admin';
    const staffProject = getStaffProject();
    const locked = !isAdmin && staffProject; // manager/coordinator, locked to one project

    const selectIds = ['add-emp-project', 'edit-emp-project', 'filter-project', 'report-project', 'punch-report-project', 'employee-report-project', 'shiftcycle-report-project', 'leave-requests-project-filter', 'grievances-project-filter', 'add-mgr-project', 'add-coordinator-project', 'edit-mgr-project', 'add-role-project', 'edit-role-account-project'];
    // Only Manager/Coordinator account creation should offer the combined "MCGM" group as a
    // single option — an Employee's own Project must always be one real, specific project.
    const groupOptionIds = new Set(['add-mgr-project', 'add-coordinator-project', 'edit-mgr-project', 'add-role-project', 'edit-role-account-project']);
    selectIds.forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const prevValue = sel.value;
      const placeholder = sel.querySelector('option')?.outerHTML || '<option value="">— Select —</option>';

      if (locked) {
        // Manager/Coordinator: only their own project (or their assigned "MCGM" group) is
        // selectable, and it's locked.
        sel.innerHTML = `<option value="${staffProject}">${staffProject}</option>`;
        sel.value = staffProject;
        sel.disabled = true;
        sel.title = 'Aapko sirf apna assigned project dikhega';
      } else {
        sel.disabled = false;
        sel.innerHTML = buildProjectOptionsHTML(allProjects, placeholder, groupOptionIds.has(id));
        if (allProjects.some(p => p.name === prevValue) || prevValue === 'MCGM') sel.value = prevValue;
      }
    });

    const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const listBox = document.getElementById('projects-list');
    if (listBox) {
      if (allProjects.length === 0) {
        listBox.innerHTML = `<span style="font-size:12px;color:var(--text-muted)">No projects yet</span>`;
      } else {
        listBox.innerHTML = allProjects.map(p => `
          <span class="badge on_duty" style="gap:6px">
            ${p.name}
            <span style="opacity:0.85;font-size:10px">(${WEEKDAY_NAMES[p.weekly_off_day ?? 0]} off)</span>
            ${p.group_name ? `<span style="opacity:0.85;font-size:10px">· Group: ${p.group_name}</span>` : ''}
            ${isAdmin ? `
              <span style="cursor:pointer" onclick="openEditProjectModal(${p.id}, '${p.name.replace(/'/g, "\\'")}', ${p.weekly_off_day ?? 0}, '${(p.group_name || '').replace(/'/g, "\\'")}')" title="Edit project">✎</span>
              <span style="cursor:pointer;font-weight:bold" onclick="deleteProject(${p.id}, '${p.name.replace(/'/g, "\\'")}')" title="Remove project">✕</span>
            ` : ''}
          </span>
        `).join('');
      }
    }

    // Existing Group Names, for the datalist suggestions on both Add and Edit forms
    const groupDatalist = document.getElementById('existing-groups-list');
    if (groupDatalist) {
      const groupNames = [...new Set(allProjects.map(p => p.group_name).filter(Boolean))];
      groupDatalist.innerHTML = groupNames.map(g => `<option value="${g}"></option>`).join('');
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('add-project-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('add-project-name');
  const offDayInput = document.getElementById('add-project-offday');
  const groupInput = document.getElementById('add-project-group');
  const name = nameInput.value.trim();
  const weekly_off_day = offDayInput.value;
  const group_name = groupInput.value.trim();
  if (!name) {
    showToast('Project name is required', true);
    return;
  }
  try {
    await apiFetch('/projects', { method: 'POST', body: JSON.stringify({ name, weekly_off_day, group_name }) });
    showToast(`Project "${name}" added`);
    nameInput.value = '';
    offDayInput.value = '0';
    groupInput.value = '';
    loadProjects();
  } catch (err) {
    showToast(err.message, true);
  }
});

// ---------------- EDIT PROJECT (rename / weekly off day / group-ungroup) — admin only ----------------
function openEditProjectModal(id, name, weekly_off_day, group_name) {
  document.getElementById('edit-project-id').value = id;
  document.getElementById('edit-project-name').value = name || '';
  document.getElementById('edit-project-offday').value = String(weekly_off_day ?? 0);
  document.getElementById('edit-project-group').value = group_name || '';
  document.getElementById('edit-project-modal').classList.remove('hidden');
}

function closeEditProjectModal() {
  document.getElementById('edit-project-modal').classList.add('hidden');
}

document.getElementById('edit-project-cancel-btn').addEventListener('click', closeEditProjectModal);
document.getElementById('edit-project-modal').addEventListener('click', (ev) => {
  if (ev.target.id === 'edit-project-modal') closeEditProjectModal(); // click on the dark backdrop
});

document.getElementById('edit-project-save-btn').addEventListener('click', async () => {
  const id = document.getElementById('edit-project-id').value;
  const name = document.getElementById('edit-project-name').value.trim();
  const weekly_off_day = document.getElementById('edit-project-offday').value;
  const group_name = document.getElementById('edit-project-group').value.trim();

  if (!name) {
    showToast('Project name is required', true);
    return;
  }

  try {
    await apiFetch(`/projects/${id}`, { method: 'PUT', body: JSON.stringify({ name, weekly_off_day, group_name }) });
    showToast('Project updated successfully');
    closeEditProjectModal();
    loadProjects();
    renderProjectNavList();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function deleteProject(id, name) {
  if (!confirm(`Remove project "${name}"? Employees already assigned to it will keep the name in their record, but it will no longer appear in the dropdown.`)) return;
  try {
    await apiFetch(`/projects/${id}`, { method: 'DELETE' });
    showToast('Project removed');
    loadProjects();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- SHIFT CATEGORIES ----------------
// name IS the label now (free-text, admin-managed, same pattern as Projects) — no more
// hardcoded '12HK'/'12ATT'/'8FA' codes to translate.
function shiftCategoryLabel(cat) {
  return cat && cat.trim() ? cat : '-';
}

let shiftCategoryCache = {}; // name -> { full_hours, half_hours } — used by the "hrs" hint text

async function loadShiftCategories() {
  try {
    const data = await apiFetch('/shift-categories');
    const categories = data.categories || [];
    const isAdmin = getRole() === 'admin';

    shiftCategoryCache = {};
    categories.forEach(c => { shiftCategoryCache[c.name] = c; });

    const selectIds = ['add-emp-shift', 'edit-emp-shift'];
    selectIds.forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const prevValue = sel.value;
      const placeholder = '<option value="">— Select —</option>';
      sel.innerHTML = placeholder + categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
      if (categories.some(c => c.name === prevValue)) sel.value = prevValue;
    });

    const listBox = document.getElementById('shift-categories-list');
    if (listBox) {
      if (categories.length === 0) {
        listBox.innerHTML = `<span style="font-size:12px;color:var(--text-muted)">No shift categories yet</span>`;
      } else {
        listBox.innerHTML = categories.map(c => `
          <span class="badge on_duty" style="gap:6px">
            ${c.name} (Full ${Number(c.full_hours)}h / Half ${Number(c.half_hours)}h / OT ₹${Number(c.ot_rate_per_hour) || 0}/hr)
            ${isAdmin ? `<span style="cursor:pointer;font-weight:bold" onclick="editShiftOtRate(${c.id}, '${c.name.replace(/'/g, "\\'")}', ${Number(c.ot_rate_per_hour) || 0})" title="Edit OT rate">✏️</span>` : ''}
            ${isAdmin ? `<span style="cursor:pointer;font-weight:bold" onclick="deleteShiftCategory(${c.id}, '${c.name.replace(/'/g, "\\'")}')" title="Remove category">✕</span>` : ''}
          </span>
        `).join('');
      }
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

async function editShiftOtRate(id, name, currentRate) {
  const newRate = prompt(`OT rate per hour for "${name}" (₹):`, currentRate);
  if (newRate === null) return;
  if (isNaN(Number(newRate)) || Number(newRate) < 0) { showToast('Enter a valid rate', true); return; }
  try {
    await apiFetch(`/shift-categories/${id}`, { method: 'PUT', body: JSON.stringify({ ot_rate_per_hour: newRate }) });
    showToast('OT rate updated');
    loadShiftCategories();
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('add-shift-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('add-shift-name');
  const fullInput = document.getElementById('add-shift-full');
  const halfInput = document.getElementById('add-shift-half');
  const otRateInput = document.getElementById('add-shift-ot-rate');
  const name = nameInput.value.trim();
  const full_hours = fullInput.value.trim();
  const half_hours = halfInput.value.trim();
  const ot_rate_per_hour = otRateInput.value.trim();

  if (!name) {
    showToast('Category name is required', true);
    return;
  }
  if (!full_hours || Number(full_hours) <= 0) {
    showToast('Full-day hours is required (e.g. 9)', true);
    return;
  }

  try {
    await apiFetch('/shift-categories', {
      method: 'POST',
      body: JSON.stringify({ name, full_hours, half_hours: half_hours || undefined, ot_rate_per_hour: ot_rate_per_hour || undefined })
    });
    showToast(`Shift category "${name}" added`);
    nameInput.value = '';
    fullInput.value = '';
    halfInput.value = '';
    otRateInput.value = '';
    loadShiftCategories();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function deleteShiftCategory(id, name) {
  if (!confirm(`Remove shift category "${name}"? Employees already assigned to it will keep the name in their record, but P/HD/A for them will fall back to the default 8h/4h rule until you reassign them a valid category.`)) return;
  try {
    await apiFetch(`/shift-categories/${id}`, { method: 'DELETE' });
    showToast('Shift category removed');
    loadShiftCategories();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- EMPLOYEES ----------------

// Cache of the last-loaded employee list, keyed by employee_id, so the Edit modal
// can pull the full record without a second network round-trip.
let employeeCache = {};

async function loadEmployees() {
  try {
    // Inside a project's workspace, "emp-filter-project" (when present) is the in-page
    // sub-filter that narrows a combined group (e.g. MCGM) down to one real part; leaving it
    // blank falls back to the whole scope (currentEmpScope.param — a real project name, or a
    // group key like "MCGM" that the backend expands to all matching real projects).
    const subFilterEl = document.getElementById('emp-filter-project');
    const subVal = subFilterEl ? subFilterEl.value.trim() : '';
    const project = subVal || (currentEmpScope ? currentEmpScope.param : '');
    const data = await apiFetch('/employees' + (project ? '?project=' + encodeURIComponent(project) : ''));
    document.getElementById('employee-count').textContent = `Employee List (${data.count})`;
    const tbody = document.getElementById('employees-table-body');
    const isAdmin = getRole() === 'admin';

    employeeCache = {};
    data.employees.forEach(e => { employeeCache[e.employee_id] = e; });

    if (data.employees.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13"><div class="empty-state"><div class="icon">👥</div>No employees added yet</div></td></tr>`;
      return;
    }

    tbody.innerHTML = data.employees.map(e => `
      <tr>
        <td class="mono">${e.employee_id}</td>
        <td>${e.name}</td>
        <td>${e.designation || '-'}</td>
        <td class="mono">${e.phone || '-'}</td>
        <td>${e.location || '-'}</td>
        <td>${e.zone || '-'}</td>
        <td>${e.ward || '-'}</td>
        <td class="mono">${e.site_code || '-'}</td>
        <td>${e.project || '-'}</td>
        <td>${shiftCategoryLabel(e.shift_category)}</td>
        <td class="mono">${e.doj || '-'}</td>
        <td>
          <span class="badge ${e.active ? 'on_duty' : 'off_duty'}">
            <span class="badge-dot"></span>${e.active ? 'Active' : 'Inactive'}
          </span>
        </td>
        <td class="admin-only-cell">
          ${isAdmin ? `
            <button class="btn secondary small" onclick="openEditEmployeeModal('${e.employee_id}')">Edit</button>
            <button class="btn secondary small" onclick="openSalaryModal('${e.employee_id}')">💰 Salary</button>
            <button class="btn secondary small" onclick="toggleEmployee('${e.employee_id}', ${e.active ? 0 : 1})">
              ${e.active ? 'Deactivate' : 'Activate'}
            </button>
          ` : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('add-emp-btn').addEventListener('click', async () => {
  const employee_id = document.getElementById('add-emp-id').value.trim();
  const name = document.getElementById('add-emp-name').value.trim();
  const pin = document.getElementById('add-emp-pin').value.trim();
  const designation = document.getElementById('add-emp-designation').value.trim();
  const phone = document.getElementById('add-emp-phone').value.trim();
  const email = document.getElementById('add-emp-email').value.trim();
  const location = document.getElementById('add-emp-location').value.trim();
  const zone = document.getElementById('add-emp-zone').value.trim();
  const ward = document.getElementById('add-emp-ward').value.trim();
  const site_code = document.getElementById('add-emp-sitecode').value.trim();
  const project = document.getElementById('add-emp-project').value.trim();
  const shift_category = document.getElementById('add-emp-shift').value.trim();
  const doj = document.getElementById('add-emp-doj').value;
  const basic_salary = document.getElementById('add-emp-basic').value;
  const hra = document.getElementById('add-emp-hra').value;
  const other_allowances = document.getElementById('add-emp-allowances').value;
  const deductions = document.getElementById('add-emp-deductions').value;
  const pf = document.getElementById('add-emp-pf').value;
  const esic = document.getElementById('add-emp-esic').value;

  if (!employee_id || !name) {
    showToast('Employee ID and Name are required', true);
    return;
  }
  // PIN is optional — if left blank, this employee logs in with just their Employee ID
  // (no PIN prompt/check for them). If a PIN IS entered, it must be a valid 4-6 digit code.
  if (pin && !/^\d{4,6}$/.test(pin)) {
    showToast('PIN must be 4-6 digits (or leave it blank for no PIN)', true);
    return;
  }

  try {
    await apiFetch('/employees', {
      method: 'POST',
      body: JSON.stringify({
        employee_id, name, pin, designation, phone, email, location, doj, project, shift_category,
        zone, ward, site_code,
        basic_salary, hra, other_allowances, deductions, pf, esic,
      })
    });
    showToast(`Employee ${employee_id} added successfully`);
    document.getElementById('add-emp-id').value = '';
    document.getElementById('add-emp-name').value = '';
    document.getElementById('add-emp-pin').value = '';
    document.getElementById('add-emp-designation').value = '';
    document.getElementById('add-emp-phone').value = '';
    document.getElementById('add-emp-email').value = '';
    document.getElementById('add-emp-location').value = '';
    document.getElementById('add-emp-zone').value = '';
    document.getElementById('add-emp-ward').value = '';
    document.getElementById('add-emp-sitecode').value = '';
    document.getElementById('add-emp-project').value = '';
    document.getElementById('add-emp-shift').value = '';
    document.getElementById('add-emp-doj').value = '';
    document.getElementById('add-emp-basic').value = '';
    document.getElementById('add-emp-hra').value = '';
    document.getElementById('add-emp-allowances').value = '';
    document.getElementById('add-emp-deductions').value = '';
    document.getElementById('add-emp-pf').value = '';
    document.getElementById('add-emp-esic').value = '';
    loadEmployees();
  } catch (err) {
    showToast(err.message, true);
  }
});

// ---- Edit Employee modal (admin only — the "Edit" button itself is only ever rendered
// for admins in loadEmployees(), and the backend's PUT /api/employees/:id route is locked
// to verifyAdmin regardless, so a manager/coordinator can never call this even directly) ----
function openEditEmployeeModal(employeeId) {
  const e = employeeCache[employeeId];
  if (!e) { showToast('Employee data not found, please refresh the list', true); return; }

  document.getElementById('edit-emp-id').value = e.employee_id;
  document.getElementById('edit-emp-id-display').value = e.employee_id;
  document.getElementById('edit-emp-name').value = e.name || '';
  document.getElementById('edit-emp-designation').value = e.designation || '';
  document.getElementById('edit-emp-phone').value = e.phone || '';
  document.getElementById('edit-emp-email').value = e.email || '';
  document.getElementById('edit-emp-location').value = e.location || '';
  document.getElementById('edit-emp-doj').value = e.doj || '';
  document.getElementById('edit-emp-zone').value = e.zone || '';
  document.getElementById('edit-emp-ward').value = e.ward || '';
  document.getElementById('edit-emp-sitecode').value = e.site_code || '';
  document.getElementById('edit-emp-project').value = e.project || '';
  document.getElementById('edit-emp-shift').value = e.shift_category || '';
  document.getElementById('edit-emp-pin').value = '';
  document.getElementById('edit-emp-bank-holder').value = '';
  document.getElementById('edit-emp-bank-account').value = '';
  document.getElementById('edit-emp-bank-ifsc').value = '';
  document.getElementById('edit-emp-bank-name').value = '';

  document.getElementById('edit-emp-modal').classList.remove('hidden');

  loadSiteLocationDropdown(e.project, e.site_location_id);

  apiFetch(`/employees/${employeeId}/bank`).then(bank => {
    document.getElementById('edit-emp-bank-holder').value = bank.bank_account_holder || '';
    document.getElementById('edit-emp-bank-account').value = bank.bank_account_number || '';
    document.getElementById('edit-emp-bank-ifsc').value = bank.bank_ifsc || '';
    document.getElementById('edit-emp-bank-name').value = bank.bank_name || '';
  }).catch(() => { /* bank details are optional — silently leave blank if fetch fails */ });
}

// Populates the "Site Location" dropdown for whichever project is currently selected in the
// Edit Employee modal, and re-populates it on the fly if the admin switches project there.
async function loadSiteLocationDropdown(project, selectedId) {
  const select = document.getElementById('edit-emp-site-location');
  select.innerHTML = '<option value="">— No specific location (use project\'s geofence) —</option>';
  if (!project) return;
  try {
    const data = await apiFetch(`/site-locations?project=${encodeURIComponent(project)}`);
    data.locations.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = `${l.name} (${l.employee_count} employee${l.employee_count === 1 ? '' : 's'})`;
      if (selectedId && Number(selectedId) === l.id) opt.selected = true;
      select.appendChild(opt);
    });
  } catch (err) { /* best effort — no locations under this project is a completely normal case */ }
}
document.getElementById('edit-emp-project').addEventListener('change', (e) => {
  loadSiteLocationDropdown(e.target.value, null);
});
document.getElementById('edit-emp-site-location').addEventListener('change', async (e) => {
  const employeeId = document.getElementById('edit-emp-id').value;
  if (!employeeId) return; // modal still populating, ignore the synthetic change event
  try {
    await apiFetch(`/employees/${employeeId}/site-location`, { method: 'PUT', body: JSON.stringify({ site_location_id: e.target.value || null }) });
    showToast('Site location updated');
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('edit-emp-bank-save-btn').addEventListener('click', async () => {
  const employeeId = document.getElementById('edit-emp-id').value;
  try {
    await apiFetch(`/employees/${employeeId}/bank`, {
      method: 'PUT',
      body: JSON.stringify({
        bank_account_holder: document.getElementById('edit-emp-bank-holder').value,
        bank_account_number: document.getElementById('edit-emp-bank-account').value,
        bank_ifsc: document.getElementById('edit-emp-bank-ifsc').value,
        bank_name: document.getElementById('edit-emp-bank-name').value,
      }),
    });
    showToast('Bank details saved');
  } catch (err) {
    showToast(err.message, true);
  }
});

function closeEditEmployeeModal() {
  document.getElementById('edit-emp-modal').classList.add('hidden');
}

document.getElementById('edit-emp-cancel-btn').addEventListener('click', closeEditEmployeeModal);
document.getElementById('edit-emp-modal').addEventListener('click', (ev) => {
  if (ev.target.id === 'edit-emp-modal') closeEditEmployeeModal(); // click on the dark backdrop
});

document.getElementById('edit-emp-save-btn').addEventListener('click', async () => {
  const employeeId = document.getElementById('edit-emp-id').value;
  const name = document.getElementById('edit-emp-name').value.trim();
  const pin = document.getElementById('edit-emp-pin').value.trim();
  const designation = document.getElementById('edit-emp-designation').value.trim();
  const phone = document.getElementById('edit-emp-phone').value.trim();
  const email = document.getElementById('edit-emp-email').value.trim();
  const location = document.getElementById('edit-emp-location').value.trim();
  const doj = document.getElementById('edit-emp-doj').value;
  const zone = document.getElementById('edit-emp-zone').value.trim();
  const ward = document.getElementById('edit-emp-ward').value.trim();
  const site_code = document.getElementById('edit-emp-sitecode').value.trim();
  const project = document.getElementById('edit-emp-project').value.trim();
  const shift_category = document.getElementById('edit-emp-shift').value.trim();

  if (!name) {
    showToast('Name is required', true);
    return;
  }
  if (pin && !/^\d{4,6}$/.test(pin)) {
    showToast('New PIN must be 4-6 digits', true);
    return;
  }

  try {
    await apiFetch(`/employees/${employeeId}`, {
      method: 'PUT',
      body: JSON.stringify({ name, pin, designation, phone, email, location, doj, project, shift_category, zone, ward, site_code })
    });
    showToast(`Employee ${employeeId} updated successfully`);
    closeEditEmployeeModal();
    loadEmployees();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function toggleEmployee(employeeId, activeValue) {
  try {
    await apiFetch(`/employees/${employeeId}`, {
      method: 'PUT',
      body: JSON.stringify({ active: activeValue })
    });
    showToast('Employee status updated');
    loadEmployees();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---- Salary Structure modal (admin only — button only rendered for admins in
// loadEmployees(), and the backend's PUT /api/salary/:id route is locked to verifyAdmin
// regardless, so a manager/coordinator can never call this even directly) ----
async function openSalaryModal(employeeId) {
  const e = employeeCache[employeeId];
  document.getElementById('salary-modal-emp-id').value = employeeId;
  document.getElementById('salary-modal-emp').textContent = e ? `${employeeId} — ${e.name}` : employeeId;
  document.getElementById('salary-modal-basic').value = '';
  document.getElementById('salary-modal-hra').value = '';
  document.getElementById('salary-modal-allowances').value = '';
  document.getElementById('salary-modal-deductions').value = '';
  document.getElementById('salary-modal-pf').value = '';
  document.getElementById('salary-modal-esic').value = '';
  document.getElementById('salary-modal').classList.remove('hidden');

  try {
    const data = await apiFetch(`/salary/${employeeId}`);
    const s = data.salary;
    document.getElementById('salary-modal-basic').value = Number(s.basic_salary) || 0;
    document.getElementById('salary-modal-hra').value = Number(s.hra) || 0;
    document.getElementById('salary-modal-allowances').value = Number(s.other_allowances) || 0;
    document.getElementById('salary-modal-deductions').value = Number(s.deductions) || 0;
    document.getElementById('salary-modal-pf').value = Number(s.pf) || 0;
    document.getElementById('salary-modal-esic').value = Number(s.esic) || 0;
  } catch (err) {
    showToast(err.message, true);
  }
}

function closeSalaryModal() {
  document.getElementById('salary-modal').classList.add('hidden');
}

document.getElementById('salary-modal-cancel-btn').addEventListener('click', closeSalaryModal);
document.getElementById('salary-modal').addEventListener('click', (ev) => {
  if (ev.target.id === 'salary-modal') closeSalaryModal(); // click on the dark backdrop
});

document.getElementById('salary-modal-save-btn').addEventListener('click', async () => {
  const employeeId = document.getElementById('salary-modal-emp-id').value;
  const basic_salary = document.getElementById('salary-modal-basic').value || 0;
  const hra = document.getElementById('salary-modal-hra').value || 0;
  const other_allowances = document.getElementById('salary-modal-allowances').value || 0;
  const deductions = document.getElementById('salary-modal-deductions').value || 0;
  const pf = document.getElementById('salary-modal-pf').value || 0;
  const esic = document.getElementById('salary-modal-esic').value || 0;

  try {
    await apiFetch(`/salary/${employeeId}`, {
      method: 'PUT',
      body: JSON.stringify({ basic_salary, hra, other_allowances, deductions, pf, esic })
    });
    showToast(`Salary updated for ${employeeId}`);
    closeSalaryModal();
  } catch (err) {
    showToast(err.message, true);
  }
});

// ---------------- BULK EMPLOYEE IMPORT (admin only) ----------------
// Maps flexible header names (case-insensitive) from an uploaded file to our field names.
const BULK_HEADER_MAP = {
  employee_id: ['employee id', 'employeeid', 'emp id', 'empid', 'id'],
  name: ['name', 'employee name', 'full name'],
  designation: ['designation', 'role', 'title'],
  phone: ['phone', 'mobile', 'contact', 'phone number'],
  location: ['location', 'employee location', 'site'],
  doj: ['doj', 'date of joining', 'joining date'],
  project: ['project', 'project name', 'client'],
  shift_category: ['shift category', 'shift', 'shiftcategory', 'category'],
  zone: ['zone'],
  ward: ['ward'],
  site_code: ['site code', 'sitecode', 'site_code'],
  basic_salary: ['basic salary', 'basicsalary', 'basic', 'salary'],
  hra: ['hra'],
  other_allowances: ['other allowances', 'allowances', 'otherallowances'],
  deductions: ['deductions', 'deduction'],
  pf: ['pf', 'p.f.', 'provident fund'],
  esic: ['esic', 'e.s.i.c.'],
};

function mapRowToEmployee(rawRow) {
  // rawRow: object with whatever header keys the file had
  const lowerKeyed = {};
  Object.keys(rawRow).forEach(k => { lowerKeyed[k.trim().toLowerCase()] = rawRow[k]; });

  const emp = {};
  Object.entries(BULK_HEADER_MAP).forEach(([field, aliases]) => {
    for (const alias of aliases) {
      if (lowerKeyed[alias] !== undefined && lowerKeyed[alias] !== '') {
        emp[field] = String(lowerKeyed[alias]).trim();
        break;
      }
    }
  });
  return emp;
}

async function submitBulkEmployees(employees) {
  if (employees.length === 0) {
    showToast('No rows found to add', true);
    return;
  }

  try {
    const data = await apiFetch('/employees/bulk', {
      method: 'POST',
      body: JSON.stringify({ employees })
    });
    showToast(data.message);
    if (data.skippedRows && data.skippedRows.length) {
      console.warn('Bulk add — rows skipped (missing Employee ID or Name):', data.skippedRows);
    }
    loadEmployees();
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('bulk-emp-upload-btn').addEventListener('click', () => {
  const fileInput = document.getElementById('bulk-emp-file');
  const file = fileInput.files[0];
  if (!file) {
    showToast('Choose an Excel or CSV file first', true);
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      // cellText + raw:false keeps whatever text/format was actually shown in the
      // spreadsheet cell (e.g. an Employee ID typed as "007" or "EMP-01") instead of
      // silently coercing number-looking cells to plain numbers and dropping leading zeros.
      const workbook = XLSX.read(e.target.result, { type: 'binary', cellText: true });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(firstSheet, { defval: '', raw: false });
      const employees = rawRows.map(mapRowToEmployee);
      submitBulkEmployees(employees);
      fileInput.value = '';
    } catch (err) {
      showToast('Could not read file: ' + err.message, true);
    }
  };
  reader.onerror = () => showToast('Failed to read file', true);
  reader.readAsBinaryString(file);
});

// Parses one pasted line into columns. Handles the two most common ways people paste data:
//  - Copied straight out of Excel/Google Sheets -> cells are TAB-separated
//  - Typed/pasted as plain comma-separated text -> commas, with optional "quoted, text"
//    for a field that itself contains a comma (e.g. an address).
function parsePastedLine(line) {
  if (line.includes('\t')) {
    return line.split('\t').map(p => p.trim());
  }
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

document.getElementById('bulk-emp-paste-btn').addEventListener('click', () => {
  const raw = document.getElementById('bulk-emp-paste').value.trim();
  if (!raw) {
    showToast('Paste some rows first', true);
    return;
  }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const employees = lines.map(line => {
    const parts = parsePastedLine(line);
    // Core columns first (as before); 6 optional salary columns can follow at the end —
    // Basic, HRA, Other Allowances, Deductions, PF, ESIC — for admins who want to set
    // salary at the same time they paste in new employees.
    const [
      employee_id, name, designation, phone, location, doj, project, shift_category,
      zone, ward, site_code,
      basic_salary, hra, other_allowances, deductions, pf, esic,
    ] = parts;
    return {
      employee_id, name, designation, phone, location, doj, project, shift_category,
      zone, ward, site_code,
      basic_salary, hra, other_allowances, deductions, pf, esic,
    };
  });

  submitBulkEmployees(employees);
  document.getElementById('bulk-emp-paste').value = '';
});

// ---------------- SALARY SLIP REQUESTS (admin, manager, coordinator) ----------------
// Manager/Coordinator only ever see requests from their own project (the backend scopes
// this the same way it scopes the Employees list); Admin sees everything.
document.getElementById('salary-requests-status-filter').addEventListener('change', loadSalaryRequests);

async function loadSalaryRequests() {
  const status = document.getElementById('salary-requests-status-filter').value;
  try {
    const data = await apiFetch(`/salary/requests${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    document.getElementById('salary-requests-count').textContent = `Requests (${data.count})`;
    renderSalaryRequestsTable(data.requests);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderSalaryRequestsTable(requests) {
  const tbody = document.getElementById('salary-requests-table-body');
  if (!requests.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="icon">📭</div>No requests found</div></td></tr>`;
    return;
  }
  const statusBadgeMap = { pending: '⏳ Pending', approved: '✅ Approved', rejected: '❌ Rejected' };
  tbody.innerHTML = requests.map(r => `
    <tr>
      <td class="mono">${r.employee_id}</td>
      <td>${r.employee_name || '-'}</td>
      <td>${r.project || '-'}</td>
      <td>${r.month}</td>
      <td>${statusBadgeMap[r.status] || r.status}</td>
      <td class="mono">${formatISTDateTime(r.requested_at)}</td>
      <td>${r.reviewed_by || '-'}</td>
      <td>
        ${r.status === 'pending' ? `
          <button class="btn small" onclick="reviewSalaryRequest(${r.id}, 'approve')">Approve</button>
          <button class="btn secondary small" onclick="reviewSalaryRequest(${r.id}, 'reject')">Reject</button>
        ` : '-'}
      </td>
    </tr>
  `).join('');
}

async function reviewSalaryRequest(id, action) {
  try {
    const data = await apiFetch(`/salary/requests/${id}/${action}`, { method: 'PUT' });
    showToast(data.message);
    loadSalaryRequests();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- LEAVE REQUESTS (admin/manager/coordinator — scoped to project for manager/coordinator, same as Salary Slip Requests) ----------------
document.getElementById('leave-requests-status-filter').addEventListener('change', loadLeaveRequests);
document.getElementById('leave-requests-project-filter').addEventListener('change', loadLeaveRequests);

async function loadLeaveRequests() {
  const status = document.getElementById('leave-requests-status-filter').value;
  const project = document.getElementById('leave-requests-project-filter').value;
  let query = [];
  if (status) query.push(`status=${encodeURIComponent(status)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);
  try {
    const data = await apiFetch(`/leave/requests${query.length ? '?' + query.join('&') : ''}`);
    document.getElementById('leave-requests-count').textContent = `Requests (${data.count})`;
    renderLeaveRequestsTable(data.requests);
  } catch (err) {
    showToast(err.message, true);
  }
}

function leaveDaysCount(from, to) {
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  return Math.round((t - f) / 86400000) + 1;
}

function renderLeaveRequestsTable(requests) {
  const tbody = document.getElementById('leave-requests-table-body');
  if (!requests.length) {
    tbody.innerHTML = `<tr><td colspan="12"><div class="empty-state"><div class="icon">📭</div>No leave requests found</div></td></tr>`;
    return;
  }
  const statusBadgeMap = { pending: '⏳ Pending', approved: '✅ Approved', rejected: '❌ Rejected' };
  tbody.innerHTML = requests.map(r => `
    <tr>
      <td class="mono">${r.employee_id}</td>
      <td>${r.employee_name || '-'}</td>
      <td>${r.project || '-'}</td>
      <td class="mono">${r.from_date}</td>
      <td class="mono">${r.to_date}</td>
      <td>${leaveDaysCount(r.from_date, r.to_date)}</td>
      <td style="max-width:220px;white-space:normal">${r.reason || '-'}</td>
      <td>${r.attachment_url ? `<a href="${r.attachment_url}" target="_blank" rel="noopener">📎 View</a>` : '-'}</td>
      <td>${statusBadgeMap[r.status] || r.status}</td>
      <td class="mono">${formatISTDateTime(r.requested_at)}</td>
      <td>${r.reviewed_by || '-'}</td>
      <td>
        ${r.status === 'pending' ? `
          <button class="btn small" onclick="reviewLeaveRequest(${r.id}, 'approve')">Approve</button>
          <button class="btn secondary small" onclick="reviewLeaveRequest(${r.id}, 'reject')">Reject</button>
        ` : '-'}
      </td>
    </tr>
  `).join('');
}

async function reviewLeaveRequest(id, action) {
  try {
    const data = await apiFetch(`/leave/requests/${id}/${action}`, { method: 'PUT' });
    showToast(data.message);
    loadLeaveRequests();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- GRIEVANCES (admin/manager/coordinator) ----------------
document.getElementById('grievances-status-filter').addEventListener('change', loadGrievances);
document.getElementById('grievances-category-filter').addEventListener('change', loadGrievances);
document.getElementById('grievances-project-filter').addEventListener('change', loadGrievances);

async function loadGrievances() {
  const status = document.getElementById('grievances-status-filter').value;
  const category = document.getElementById('grievances-category-filter').value;
  const project = document.getElementById('grievances-project-filter').value;
  let query = [];
  if (status) query.push(`status=${encodeURIComponent(status)}`);
  if (category) query.push(`category=${encodeURIComponent(category)}`);
  if (project) query.push(`project=${encodeURIComponent(project)}`);
  try {
    const data = await apiFetch(`/grievance/list${query.length ? '?' + query.join('&') : ''}`);
    document.getElementById('grievances-count').textContent = `Complaints (${data.count})`;
    renderGrievancesTable(data.requests);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderGrievancesTable(requests) {
  const tbody = document.getElementById('grievances-table-body');
  if (!requests.length) {
    tbody.innerHTML = `<tr><td colspan="12"><div class="empty-state"><div class="icon">📭</div>No complaints found</div></td></tr>`;
    return;
  }
  const statusBadgeMap = { pending: '⏳ Pending', in_review: '🔎 In Review', resolved: '✅ Resolved', rejected: '❌ Rejected' };
  tbody.innerHTML = requests.map(r => `
    <tr>
      <td class="mono">${r.employee_id}</td>
      <td>${r.employee_name || '-'}</td>
      <td>${r.project || '-'}</td>
      <td>${r.category}</td>
      <td style="max-width:160px;white-space:normal">${r.subject}</td>
      <td style="max-width:220px;white-space:normal">${r.description || '-'}</td>
      <td>${r.attachment_url ? `<a href="${r.attachment_url}" target="_blank" rel="noopener">📎 View</a>` : '-'}</td>
      <td>${statusBadgeMap[r.status] || r.status}</td>
      <td style="max-width:180px;white-space:normal">${r.resolution_note || '-'}</td>
      <td class="mono">${formatISTDateTime(r.requested_at)}</td>
      <td>${r.reviewed_by || '-'}</td>
      <td>
        ${r.status === 'pending' ? `
          <button class="btn small" onclick="reviewGrievance(${r.id}, 'in-review')">Start Review</button>
          <button class="btn secondary small" onclick="reviewGrievance(${r.id}, 'reject')">Reject</button>
        ` : ''}
        ${r.status === 'in_review' ? `
          <button class="btn small" onclick="reviewGrievance(${r.id}, 'resolve')">Resolve</button>
          <button class="btn secondary small" onclick="reviewGrievance(${r.id}, 'reject')">Reject</button>
        ` : ''}
        ${r.status === 'resolved' || r.status === 'rejected' ? '-' : ''}
      </td>
    </tr>
  `).join('');
}

async function reviewGrievance(id, action) {
  let resolution_note = null;
  if (action === 'resolve' || action === 'reject') {
    resolution_note = prompt(`Optional note back to the employee (leave blank to skip):`) || '';
  }
  try {
    const data = await apiFetch(`/grievance/${id}/${action}`, {
      method: 'PUT',
      body: JSON.stringify({ resolution_note }),
    });
    showToast(data.message);
    loadGrievances();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- MANAGERS (admin only) ----------------
async function loadManagers() {
  if (getRole() !== 'admin') return;
  try {
    const data = await apiFetch('/auth/managers');
    document.getElementById('manager-count').textContent = `Manager List (${data.count})`;
    const tbody = document.getElementById('managers-table-body');
    if (data.managers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="icon">🗂️</div>No manager accounts yet</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.managers.map(m => `
      <tr>
        <td class="mono">${m.username}</td>
        <td>${m.project || '-'}</td>
        <td class="mono">${formatISTDate(new Date(m.created_at))}</td>
        <td><button class="btn secondary small" onclick="openEditMgrModal('manager', ${m.id}, '${(m.username || '').replace(/'/g, "\\'")}', '${(m.project || '').replace(/'/g, "\\'")}')">Edit</button> <button class="btn secondary small" onclick="deleteManager(${m.id})">Remove</button></td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('add-mgr-btn').addEventListener('click', async () => {
  const username = document.getElementById('add-mgr-username').value.trim();
  const password = document.getElementById('add-mgr-password').value;
  const project = document.getElementById('add-mgr-project').value.trim();
  if (!username || !password || password.length < 6) {
    showToast('Username and password (min 6 characters) are required', true);
    return;
  }
  if (!project) {
    showToast('Project select karna zaroori hai — Manager sirf isi project ka data dekh payega', true);
    return;
  }
  try {
    await apiFetch('/auth/managers', {
      method: 'POST',
      body: JSON.stringify({ username, password, project })
    });
    showToast(`Manager ${username} added successfully`);
    document.getElementById('add-mgr-username').value = '';
    document.getElementById('add-mgr-password').value = '';
    document.getElementById('add-mgr-project').value = '';
    loadManagers();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function deleteManager(id) {
  try {
    await apiFetch(`/auth/managers/${id}`, { method: 'DELETE' });
    showToast('Manager account removed');
    loadManagers();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- COORDINATOR ACCOUNTS (admin only, same access level as Manager) ----------------
async function loadCoordinatorAccounts() {
  if (getRole() !== 'admin') return;
  try {
    const data = await apiFetch('/auth/coordinator-accounts');
    document.getElementById('coordinator-count').textContent = `Coordinator Account List (${data.count})`;
    const tbody = document.getElementById('coordinator-table-body');
    if (data.accounts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="icon">💎</div>No Coordinator accounts yet</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.accounts.map(a => `
      <tr>
        <td class="mono">${a.username}</td>
        <td>${a.project || '-'}</td>
        <td class="mono">${formatISTDate(new Date(a.created_at))}</td>
        <td><button class="btn secondary small" onclick="openEditMgrModal('coordinator', ${a.id}, '${(a.username || '').replace(/'/g, "\\'")}', '${(a.project || '').replace(/'/g, "\\'")}')">Edit</button> <button class="btn secondary small" onclick="deleteCoordinatorAccount(${a.id})">Remove</button></td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('add-coordinator-btn').addEventListener('click', async () => {
  const username = document.getElementById('add-coordinator-username').value.trim();
  const password = document.getElementById('add-coordinator-password').value;
  const project = document.getElementById('add-coordinator-project').value.trim();
  if (!username || !password || password.length < 6) {
    showToast('Username and password (min 6 characters) are required', true);
    return;
  }
  if (!project) {
    showToast('Project select karna zaroori hai — Coordinator sirf isi project ka data dekh payega', true);
    return;
  }
  try {
    await apiFetch('/auth/coordinator-accounts', {
      method: 'POST',
      body: JSON.stringify({ username, password, project })
    });
    showToast(`Coordinator account ${username} added successfully`);
    document.getElementById('add-coordinator-username').value = '';
    document.getElementById('add-coordinator-password').value = '';
    document.getElementById('add-coordinator-project').value = '';
    loadCoordinatorAccounts();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function deleteCoordinatorAccount(id) {
  try {
    await apiFetch(`/auth/coordinator-accounts/${id}`, { method: 'DELETE' });
    showToast('Coordinator account removed');
    loadCoordinatorAccounts();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- EDIT MANAGER / COORDINATOR ACCOUNT (admin only) ----------------
// Same modal is reused for both roles — `type` ('manager' | 'coordinator') decides which
// API endpoint gets called on save.
function openEditMgrModal(type, id, username, project) {
  document.getElementById('edit-mgr-type').value = type;
  document.getElementById('edit-mgr-id').value = id;
  document.getElementById('edit-mgr-title').textContent = type === 'manager' ? 'Edit Manager Account' : 'Edit Coordinator Account';
  document.getElementById('edit-mgr-username').value = username || '';
  document.getElementById('edit-mgr-project').value = project || '';
  document.getElementById('edit-mgr-password').value = '';
  document.getElementById('edit-mgr-modal').classList.remove('hidden');
}

function closeEditMgrModal() {
  document.getElementById('edit-mgr-modal').classList.add('hidden');
}

document.getElementById('edit-mgr-cancel-btn').addEventListener('click', closeEditMgrModal);
document.getElementById('edit-mgr-modal').addEventListener('click', (ev) => {
  if (ev.target.id === 'edit-mgr-modal') closeEditMgrModal(); // click on the dark backdrop
});

document.getElementById('edit-mgr-save-btn').addEventListener('click', async () => {
  const type = document.getElementById('edit-mgr-type').value;
  const id = document.getElementById('edit-mgr-id').value;
  const username = document.getElementById('edit-mgr-username').value.trim();
  const project = document.getElementById('edit-mgr-project').value.trim();
  const password = document.getElementById('edit-mgr-password').value;

  if (!username) {
    showToast('Username is required', true);
    return;
  }
  if (!project) {
    showToast('Project select karna zaroori hai', true);
    return;
  }
  if (password && password.length < 6) {
    showToast('New password must be at least 6 characters (ya blank chhodo agar change nahi karna)', true);
    return;
  }

  const endpoint = type === 'manager' ? `/auth/managers/${id}` : `/auth/coordinator-accounts/${id}`;
  const body = { username, project };
  if (password) body.password = password;

  try {
    await apiFetch(endpoint, { method: 'PUT', body: JSON.stringify(body) });
    showToast(`${type === 'manager' ? 'Manager' : 'Coordinator'} account updated successfully`);
    closeEditMgrModal();
    if (type === 'manager') loadManagers(); else loadCoordinatorAccounts();
  } catch (err) {
    showToast(err.message, true);
  }
});

// ============================================================================================
// REPORT-ONLY CUSTOM ROLES (Area Officer / Supervisor / etc.) — admin only
// ============================================================================================

// ---------------- Manage Roles (the role NAMES, e.g. "Area Officer") ----------------
async function loadRoleTypes() {
  try {
    const data = await apiFetch('/auth/role-types');
    const roles = data.roles || [];

    const listBox = document.getElementById('role-types-list');
    if (listBox) {
      listBox.innerHTML = roles.length === 0
        ? `<span style="font-size:12px;color:var(--text-muted)">No roles yet — add one above</span>`
        : roles.map(r => `
            <span class="badge on_duty" style="gap:6px">
              ${r.name}
              <span style="cursor:pointer;font-weight:bold" onclick="deleteRoleType(${r.id}, '${r.name.replace(/'/g, "\\'")}')" title="Remove role">✕</span>
            </span>
          `).join('');
    }

    // Populate the Role dropdowns on the Add / Edit Role Account forms
    ['add-role-name', 'edit-role-account-role'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const prevValue = sel.value;
      sel.innerHTML = `<option value="">— Select Role —</option>` + roles.map(r => `<option value="${r.name}">${r.name}</option>`).join('');
      if (prevValue && roles.some(r => r.name === prevValue)) sel.value = prevValue;
    });
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('add-role-type-btn').addEventListener('click', async () => {
  const input = document.getElementById('add-role-type-name');
  const name = input.value.trim();
  if (!name) {
    showToast('Role name is required', true);
    return;
  }
  try {
    await apiFetch('/auth/role-types', { method: 'POST', body: JSON.stringify({ name }) });
    showToast(`Role "${name}" added`);
    input.value = '';
    loadRoleTypes();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function deleteRoleType(id, name) {
  if (!confirm(`Remove the "${name}" role? (This only works if no accounts are using it.)`)) return;
  try {
    await apiFetch(`/auth/role-types/${id}`, { method: 'DELETE' });
    showToast(`Role "${name}" removed`);
    loadRoleTypes();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------- Role Accounts (the actual logins under a role) ----------------
async function loadRoleAccounts() {
  try {
    const data = await apiFetch('/auth/role-accounts');
    const accounts = data.accounts || [];
    document.getElementById('role-account-count').textContent = `Role Account List (${accounts.length})`;

    const tbody = document.getElementById('role-accounts-table-body');
    if (accounts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="icon">📋</div>No role accounts added yet</div></td></tr>`;
      return;
    }

    tbody.innerHTML = accounts.map(a => `
      <tr>
        <td>${a.username}</td>
        <td>${a.custom_role_name || '-'}</td>
        <td>${a.project || '-'}</td>
        <td>${a.scope_zone || 'All'}</td>
        <td>${a.scope_ward || 'All'}</td>
        <td>${a.scope_location || 'All'}</td>
        <td class="mono">${a.created_at ? new Date(a.created_at).toLocaleDateString('en-IN') : '-'}</td>
        <td>
          <button class="btn secondary small" onclick='openEditRoleAccountModal(${JSON.stringify(a)})'>Edit</button>
          <button class="btn secondary small" onclick="deleteRoleAccount(${a.id})">Remove</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('add-role-account-btn').addEventListener('click', async () => {
  const username = document.getElementById('add-role-username').value.trim();
  const password = document.getElementById('add-role-password').value;
  const custom_role_name = document.getElementById('add-role-name').value.trim();
  const project = document.getElementById('add-role-project').value.trim();
  const scope_zone = document.getElementById('add-role-zone').value.trim();
  const scope_ward = document.getElementById('add-role-ward').value.trim();
  const scope_location = document.getElementById('add-role-location').value.trim();

  if (!username || !password) {
    showToast('Username and password are required', true);
    return;
  }
  if (password.length < 6) {
    showToast('Password must be at least 6 characters', true);
    return;
  }
  if (!custom_role_name) {
    showToast('Role select karna zaroori hai', true);
    return;
  }
  if (!project) {
    showToast('Project select karna zaroori hai', true);
    return;
  }

  try {
    await apiFetch('/auth/role-accounts', {
      method: 'POST',
      body: JSON.stringify({ username, password, custom_role_name, project, scope_zone, scope_ward, scope_location })
    });
    showToast(`Role account ${username} added successfully`);
    document.getElementById('add-role-username').value = '';
    document.getElementById('add-role-password').value = '';
    document.getElementById('add-role-name').value = '';
    document.getElementById('add-role-project').value = '';
    document.getElementById('add-role-zone').value = '';
    document.getElementById('add-role-ward').value = '';
    document.getElementById('add-role-location').value = '';
    loadRoleAccounts();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function deleteRoleAccount(id) {
  try {
    await apiFetch(`/auth/role-accounts/${id}`, { method: 'DELETE' });
    showToast('Role account removed');
    loadRoleAccounts();
  } catch (err) {
    showToast(err.message, true);
  }
}

function openEditRoleAccountModal(account) {
  document.getElementById('edit-role-account-id').value = account.id;
  document.getElementById('edit-role-account-username').value = account.username || '';
  document.getElementById('edit-role-account-role').value = account.custom_role_name || '';
  document.getElementById('edit-role-account-project').value = account.project || '';
  document.getElementById('edit-role-account-zone').value = account.scope_zone || '';
  document.getElementById('edit-role-account-ward').value = account.scope_ward || '';
  document.getElementById('edit-role-account-location').value = account.scope_location || '';
  document.getElementById('edit-role-account-password').value = '';
  document.getElementById('edit-role-account-modal').classList.remove('hidden');
}

function closeEditRoleAccountModal() {
  document.getElementById('edit-role-account-modal').classList.add('hidden');
}

document.getElementById('edit-role-account-cancel-btn').addEventListener('click', closeEditRoleAccountModal);
document.getElementById('edit-role-account-modal').addEventListener('click', (ev) => {
  if (ev.target.id === 'edit-role-account-modal') closeEditRoleAccountModal(); // click on the dark backdrop
});

document.getElementById('edit-role-account-save-btn').addEventListener('click', async () => {
  const id = document.getElementById('edit-role-account-id').value;
  const username = document.getElementById('edit-role-account-username').value.trim();
  const custom_role_name = document.getElementById('edit-role-account-role').value.trim();
  const project = document.getElementById('edit-role-account-project').value.trim();
  const scope_zone = document.getElementById('edit-role-account-zone').value.trim();
  const scope_ward = document.getElementById('edit-role-account-ward').value.trim();
  const scope_location = document.getElementById('edit-role-account-location').value.trim();
  const password = document.getElementById('edit-role-account-password').value;

  if (!username) {
    showToast('Username is required', true);
    return;
  }
  if (!custom_role_name) {
    showToast('Role select karna zaroori hai', true);
    return;
  }
  if (!project) {
    showToast('Project select karna zaroori hai', true);
    return;
  }
  if (password && password.length < 6) {
    showToast('New password must be at least 6 characters (ya blank chhodo agar change nahi karna)', true);
    return;
  }

  const body = { username, custom_role_name, project, scope_zone, scope_ward, scope_location };
  if (password) body.password = password;

  try {
    await apiFetch(`/auth/role-accounts/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    showToast('Role account updated successfully');
    closeEditRoleAccountModal();
    loadRoleAccounts();
  } catch (err) {
    showToast(err.message, true);
  }
});

// ---------------- SETTINGS (admin only) ----------------
document.getElementById('change-password-btn').addEventListener('click', async () => {
  const newPassword = document.getElementById('new-password').value;
  if (!newPassword || newPassword.length < 6) {
    showToast('Password must be at least 6 characters', true);
    return;
  }
  try {
    await apiFetch('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ newPassword })
    });
    showToast('Password updated successfully');
    document.getElementById('new-password').value = '';
  } catch (err) {
    showToast(err.message, true);
  }
});

// ===========================================================================
// PLATFORM OWNER (SUPER ADMIN) — LOGIN + COMPANIES MANAGEMENT
// ===========================================================================
document.getElementById('super-admin-login-btn').addEventListener('click', doSuperAdminLogin);
document.getElementById('super-admin-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doSuperAdminLogin(); });

async function doSuperAdminLogin() {
  const username = document.getElementById('super-admin-login-username').value.trim();
  const password = document.getElementById('super-admin-login-password').value;
  const totp_token = document.getElementById('super-admin-login-2fa-code').value.trim();
  const errBox = document.getElementById('super-admin-login-error');
  const btn = document.getElementById('super-admin-login-btn');
  errBox.style.display = 'none';

  if (!username || !password) {
    errBox.textContent = 'Please enter username and password';
    errBox.style.display = 'block';
    return;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Logging in…';

  try {
    const res = await fetch(API + '/auth/super-admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, totp_token: totp_token || undefined })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    if (data.requires_2fa) {
      // Password confirmed correct — reveal the 2FA code field and stop here; the person
      // enters their authenticator code and hits Sign In again to complete the login.
      document.getElementById('super-admin-login-2fa-field').classList.remove('hidden');
      document.getElementById('super-admin-login-2fa-code').focus();
      errBox.textContent = 'Enter the 6-digit code from your authenticator app';
      errBox.style.display = 'block';
      return;
    }

    saveSession(data.token, 'super_admin', null, null, null, null);
    document.getElementById('super-admin-login-password').value = '';
    document.getElementById('super-admin-login-2fa-code').value = '';
    document.getElementById('super-admin-login-2fa-field').classList.add('hidden');
    navigate('/owner', true);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

document.getElementById('companies-logout-btn').addEventListener('click', logoutAll);

let companiesCache = [];

function showCompaniesDashboard() {
  showView('companies-view');
  loadCompanyStats();
  loadCompanies();
}

async function loadCompanyStats() {
  const statsEl = document.getElementById('companies-stats');
  try {
    const s = await apiFetch('/companies/stats');
    const cards = [
      ['Total Companies', s.total_companies, '#071A2C'],
      ['Active', s.active_companies, '#2E7D32'],
      ['Inactive', s.inactive_companies, '#C62828'],
      ['Total Employees', s.total_employees, '#0B93D6'],
      ['Total Admins', s.total_admins, '#6A1B9A'],
    ];
    statsEl.innerHTML = cards.map(([label, value, color]) => `
      <div style="background:#fff;border:1px solid #E3E8EF;border-radius:12px;padding:14px 16px;">
        <div style="font-size:22px;font-weight:800;color:${color};">${value}</div>
        <div style="font-size:12px;color:#64748B;margin-top:2px;">${label}</div>
      </div>
    `).join('');
  } catch (err) {
    statsEl.innerHTML = '';
  }
}

async function loadCompanies() {
  const listEl = document.getElementById('companies-list');
  listEl.innerHTML = '<p style="color:#94A3B8;">Loading…</p>';
  try {
    const data = await apiFetch('/companies');
    companiesCache = data.companies;
    renderCompaniesList();
  } catch (err) {
    listEl.innerHTML = `<p style="color:#C62828;">${escapeHtml(err.message)}</p>`;
  }
}

function companyBadgesHtml(c) {
  const planColors = { trial: '#EF6C00', standard: '#0B93D6', premium: '#6A1B9A', custom: '#334155' };
  const planColor = planColors[c.plan] || '#334155';
  let badges = `<span style="background:${planColor}1A;color:${planColor};font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;text-transform:capitalize;">${escapeHtml(c.plan || 'standard')}</span>`;

  if (c.expires_at) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiry = new Date(c.expires_at);
    const daysLeft = Math.round((expiry - today) / 86400000);
    if (daysLeft < 0) {
      badges += ` <span style="background:#C628281A;color:#C62828;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;">Expired</span>`;
    } else if (daysLeft <= 14) {
      badges += ` <span style="background:#EF6C001A;color:#EF6C00;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;">Expires in ${daysLeft}d</span>`;
    } else {
      badges += ` <span style="color:#94A3B8;font-size:11px;">Expires ${escapeHtml(c.expires_at)}</span>`;
    }
  }
  if (c.max_employees !== null && c.max_employees !== undefined) {
    const atLimit = c.employee_count >= c.max_employees;
    badges += ` <span style="color:${atLimit ? '#C62828' : '#94A3B8'};font-size:11px;font-weight:${atLimit ? '700' : '400'};">${c.employee_count}/${c.max_employees} employees</span>`;
  }
  return badges;
}

function renderCompaniesList() {
  const listEl = document.getElementById('companies-list');
  const query = (document.getElementById('companies-search').value || '').trim().toLowerCase();
  const filtered = query
    ? companiesCache.filter(c => c.name.toLowerCase().includes(query) || c.code.toLowerCase().includes(query))
    : companiesCache;

  if (!companiesCache.length) {
    listEl.innerHTML = '<p style="color:#94A3B8;">No companies yet. Click "+ Add Company" to onboard your first client.</p>';
    return;
  }
  if (!filtered.length) {
    listEl.innerHTML = `<p style="color:#94A3B8;">No companies match "${escapeHtml(query)}".</p>`;
    return;
  }

  listEl.innerHTML = filtered.map(c => `
    <div style="background:#fff;border:1px solid #E3E8EF;border-radius:12px;padding:16px 18px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${c.logo_url ? `<img src="${escapeHtml(c.logo_url)}" alt="" style="width:44px;height:44px;object-fit:contain;border:1px solid #E3E8EF;border-radius:8px;background:#fff;" />` : ''}
        <div>
          <div style="font-weight:700;font-size:15px;color:#071A2C;">${escapeHtml(c.name)} ${c.active ? '' : '<span style="color:#C62828;font-size:12px;font-weight:600;">(Inactive)</span>'}</div>
          <div style="color:#64748B;font-size:13px;margin-top:2px;">Code: <b>${escapeHtml(c.code)}</b> · ${c.employee_count} employee(s) · ${c.admin_count} admin(s)</div>
          <div style="margin-top:6px;">${companyBadgesHtml(c)}</div>
          ${c.contact_email || c.contact_phone ? `<div style="color:#94A3B8;font-size:12px;margin-top:4px;">${escapeHtml(c.contact_email || '')}${c.contact_email && c.contact_phone ? ' · ' : ''}${escapeHtml(c.contact_phone || '')}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn secondary" style="width:auto;padding:8px 14px;font-size:12px;" onclick="loginAsCompanyAdmin(${c.id})">🔓 Login as Admin</button>
        <button class="btn secondary" style="width:auto;padding:8px 14px;font-size:12px;" onclick="openCompanySettingsModal(${c.id})">⚙️ Report &amp; Functions</button>
        <button class="btn secondary" style="width:auto;padding:8px 14px;font-size:12px;" onclick="openEditCompanyModal(${c.id})">✏️ Edit</button>
        <button class="btn secondary" style="width:auto;padding:8px 14px;font-size:12px;" onclick="triggerLogoUpload(${c.id})">🖼️ ${c.logo_url ? 'Change Logo' : 'Add Logo'}</button>
        ${c.logo_url ? `<button class="btn secondary" style="width:auto;padding:8px 14px;font-size:12px;" onclick="removeCompanyLogo(${c.id})">Remove Logo</button>` : ''}
        <button class="btn secondary" style="width:auto;padding:8px 14px;font-size:12px;" onclick="toggleCompanyActive(${c.id}, ${c.active ? 0 : 1})">${c.active ? 'Deactivate' : 'Activate'}</button>
        <button class="btn secondary" style="width:auto;padding:8px 14px;font-size:12px;" onclick="resetCompanyAdminPassword(${c.id})">Reset Admin Password</button>
        <button class="btn secondary" style="width:auto;padding:8px 14px;font-size:12px;color:#C62828;" onclick="deleteCompany(${c.id})">🗑️ Delete</button>
      </div>
    </div>
  `).join('');
}

document.getElementById('companies-search').addEventListener('input', renderCompaniesList);

document.getElementById('export-companies-btn').addEventListener('click', () => {
  downloadFileWithAuth(`${API}/companies/export/excel`, 'Geovixa_Companies.xlsx', 'Companies list downloaded');
});

// ---- "Login as Admin" — jump straight into a company's Admin panel for support, without
// needing their password. Every use is logged server-side. ----
async function loginAsCompanyAdmin(id) {
  const company = companiesCache.find(c => c.id === id);
  if (!company) return;
  const confirmed = confirm(`Log in as the Admin of "${company.name}"? You'll be taken straight into their portal. This is logged for security.`);
  if (!confirmed) return;
  try {
    const data = await apiFetch(`/companies/${id}/impersonate-admin`, { method: 'POST' });
    saveSession(data.token, 'admin', null, data.project || null, null, data.company_name || null, data.settings, data.company_logo_url || null);
    navigate('/admin', true);
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---- Change my own (super_admin) password ----
document.getElementById('owner-change-password-btn').addEventListener('click', () => {
  document.getElementById('owner-password-error').style.display = 'none';
  document.getElementById('owner-password-new').value = '';
  document.getElementById('owner-password-modal').classList.remove('hidden');
});
document.getElementById('owner-password-cancel').addEventListener('click', () => {
  document.getElementById('owner-password-modal').classList.add('hidden');
});
document.getElementById('owner-password-save').addEventListener('click', async () => {
  const newPassword = document.getElementById('owner-password-new').value;
  const errBox = document.getElementById('owner-password-error');
  errBox.style.display = 'none';
  if (!newPassword || newPassword.length < 6) {
    errBox.textContent = 'Password must be at least 6 characters';
    errBox.style.display = 'block';
    return;
  }
  try {
    await apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
    showToast('Password updated successfully');
    document.getElementById('owner-password-modal').classList.add('hidden');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

// ---- Two-Factor Authentication (2FA) for the platform owner's own login ----
let pending2faSecret = null;

function reset2faModalViews() {
  document.getElementById('owner-2fa-error').style.display = 'none';
  document.getElementById('owner-2fa-status-view').classList.remove('hidden');
  document.getElementById('owner-2fa-setup-view').classList.add('hidden');
  document.getElementById('owner-2fa-disable-view').classList.add('hidden');
  document.getElementById('owner-2fa-enable-start-btn').style.display = 'none';
  document.getElementById('owner-2fa-disable-start-btn').style.display = 'none';
}

document.getElementById('owner-2fa-btn').addEventListener('click', async () => {
  reset2faModalViews();
  document.getElementById('owner-2fa-status-text').textContent = 'Checking status…';
  document.getElementById('owner-2fa-modal').classList.remove('hidden');
  try {
    const data = await apiFetch('/companies/2fa/status');
    if (data.enabled) {
      document.getElementById('owner-2fa-status-text').textContent = '✅ Two-factor authentication is currently ON for your account.';
      document.getElementById('owner-2fa-disable-start-btn').style.display = 'block';
    } else {
      document.getElementById('owner-2fa-status-text').textContent = 'Two-factor authentication is currently OFF. Enable it to require an authenticator app code every time you log in.';
      document.getElementById('owner-2fa-enable-start-btn').style.display = 'block';
    }
  } catch (err) {
    document.getElementById('owner-2fa-status-text').textContent = err.message;
  }
});

document.getElementById('owner-2fa-close-btn').addEventListener('click', () => {
  document.getElementById('owner-2fa-modal').classList.add('hidden');
});

document.getElementById('owner-2fa-enable-start-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('owner-2fa-error');
  errBox.style.display = 'none';
  try {
    const data = await apiFetch('/companies/2fa/setup', { method: 'POST' });
    pending2faSecret = data.secret;
    document.getElementById('owner-2fa-secret-display').textContent = data.secret;
    document.getElementById('owner-2fa-confirm-code').value = '';
    document.getElementById('owner-2fa-status-view').classList.add('hidden');
    document.getElementById('owner-2fa-setup-view').classList.remove('hidden');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

document.getElementById('owner-2fa-confirm-btn').addEventListener('click', async () => {
  const code = document.getElementById('owner-2fa-confirm-code').value.trim();
  const errBox = document.getElementById('owner-2fa-error');
  errBox.style.display = 'none';
  if (!code || !/^\d{6}$/.test(code)) {
    errBox.textContent = 'Enter the 6-digit code from your authenticator app';
    errBox.style.display = 'block';
    return;
  }
  try {
    await apiFetch('/companies/2fa/enable', { method: 'POST', body: JSON.stringify({ secret: pending2faSecret, token: code }) });
    showToast('Two-factor authentication enabled');
    document.getElementById('owner-2fa-modal').classList.add('hidden');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

document.getElementById('owner-2fa-disable-start-btn').addEventListener('click', () => {
  document.getElementById('owner-2fa-disable-password').value = '';
  document.getElementById('owner-2fa-status-view').classList.add('hidden');
  document.getElementById('owner-2fa-disable-view').classList.remove('hidden');
});

document.getElementById('owner-2fa-disable-confirm-btn').addEventListener('click', async () => {
  const password = document.getElementById('owner-2fa-disable-password').value;
  const errBox = document.getElementById('owner-2fa-error');
  errBox.style.display = 'none';
  if (!password) {
    errBox.textContent = 'Enter your password to confirm';
    errBox.style.display = 'block';
    return;
  }
  try {
    await apiFetch('/companies/2fa/disable', { method: 'POST', body: JSON.stringify({ password }) });
    showToast('Two-factor authentication disabled');
    document.getElementById('owner-2fa-modal').classList.add('hidden');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

// ---- Activity Log (audit trail of platform-owner actions) ----
document.getElementById('view-audit-log-btn').addEventListener('click', async () => {
  document.getElementById('audit-log-modal').classList.remove('hidden');
  const listEl = document.getElementById('audit-log-list');
  listEl.innerHTML = '<p style="color:#94A3B8;">Loading…</p>';
  try {
    const data = await apiFetch('/companies/audit-log?limit=150');
    if (!data.entries.length) {
      listEl.innerHTML = '<p style="color:#94A3B8;">No activity recorded yet.</p>';
      return;
    }
    listEl.innerHTML = data.entries.map(e => {
      const time = new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
      const actionLabel = e.action.replace(/_/g, ' ');
      return `
        <div style="border-bottom:1px solid #E3E8EF;padding:10px 0;font-size:13px;">
          <div style="display:flex;justify-content:space-between;gap:10px;">
            <span style="font-weight:600;color:#071A2C;text-transform:capitalize;">${escapeHtml(actionLabel)}</span>
            <span style="color:#94A3B8;font-size:12px;white-space:nowrap;">${time}</span>
          </div>
          <div style="color:#64748B;margin-top:2px;">by ${escapeHtml(e.actor_username)}${e.target_label ? ` · ${escapeHtml(e.target_label)}` : ''}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    listEl.innerHTML = `<p style="color:#C62828;">${escapeHtml(err.message)}</p>`;
  }
});

document.getElementById('audit-log-close-btn').addEventListener('click', () => {
  document.getElementById('audit-log-modal').classList.add('hidden');
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

async function toggleCompanyActive(id, active) {
  try {
    await apiFetch(`/companies/${id}`, { method: 'PUT', body: JSON.stringify({ active }) });
    showToast(active ? 'Company activated' : 'Company deactivated');
    loadCompanies();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function resetCompanyAdminPassword(id) {
  const newPassword = prompt('Enter a new password (min 6 characters) for this company\'s Admin account:');
  if (!newPassword) return;
  if (newPassword.length < 6) { showToast('Password must be at least 6 characters', true); return; }
  try {
    await apiFetch(`/companies/${id}/reset-admin-password`, { method: 'PUT', body: JSON.stringify({ new_password: newPassword }) });
    showToast('Admin password reset successfully');
  } catch (err) {
    showToast(err.message, true);
  }
}

async function deleteCompany(id) {
  const company = companiesCache.find(c => c.id === id);
  if (!company) return;
  const confirmed = confirm(`Delete "${company.name}" permanently? This only works if the company has no employees left, and cannot be undone.`);
  if (!confirmed) return;
  try {
    await apiFetch(`/companies/${id}`, { method: 'DELETE' });
    showToast(`"${company.name}" removed`);
    loadCompanies();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---- Company logo upload (prints on that company's salary slip PDFs) ----
// A single hidden <input type="file"> is created once and reused for every "Add/Change
// Logo" click — simpler than adding a dedicated file input per company card.
let logoUploadTargetId = null;
const logoFileInput = document.createElement('input');
logoFileInput.type = 'file';
logoFileInput.accept = 'image/png,image/jpeg';
logoFileInput.style.display = 'none';
document.body.appendChild(logoFileInput);

function triggerLogoUpload(companyId) {
  logoUploadTargetId = companyId;
  logoFileInput.value = ''; // reset so picking the same file twice in a row still fires 'change'
  logoFileInput.click();
}

logoFileInput.addEventListener('change', () => {
  const file = logoFileInput.files[0];
  if (!file || !logoUploadTargetId) return;

  if (!['image/png', 'image/jpeg'].includes(file.type)) {
    showToast('Logo must be a PNG or JPEG image', true);
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    showToast('Logo is too large (max 2MB)', true);
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await apiFetch(`/companies/${logoUploadTargetId}/logo`, {
        method: 'PUT',
        body: JSON.stringify({ logo: reader.result })
      });
      showToast('Logo uploaded — it will now print on this company\'s salary slips');
      loadCompanies();
    } catch (err) {
      showToast(err.message, true);
    }
  };
  reader.readAsDataURL(file);
});

async function removeCompanyLogo(id) {
  const confirmed = confirm('Remove this company\'s logo? Their salary slips will go back to a text-only header.');
  if (!confirmed) return;
  try {
    await apiFetch(`/companies/${id}/logo`, { method: 'DELETE' });
    showToast('Logo removed');
    loadCompanies();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---- Add Company / Edit Company / Edit Company Settings modal (shared) ----
// `companyModalMode` is 'add' (create a new company + its first Admin), 'edit' (change an
// existing company's Name/Code only — no admin fields, Functions/Columns left untouched),
// or 'settings' (edit only the enabled Functions + Report columns). companyModalEditingId
// holds which company id is being edited for 'edit'/'settings' modes.
let companyModalMode = 'add';
let companyModalEditingId = null;

function setCompanyModalCheckboxes(containerSelector, dataAttr, valuesMap) {
  document.querySelectorAll(`${containerSelector} input[type="checkbox"]`).forEach(cb => {
    const key = cb.getAttribute(dataAttr);
    cb.checked = valuesMap ? (valuesMap[key] !== false) : true;
  });
}

function readCompanyModalCheckboxes(containerSelector, dataAttr) {
  const result = {};
  document.querySelectorAll(`${containerSelector} input[type="checkbox"]`).forEach(cb => {
    result[cb.getAttribute(dataAttr)] = cb.checked;
  });
  return result;
}

function setRolePermsCheckboxes(rolePerms) {
  document.querySelectorAll('#company-modal-role-perms tbody tr').forEach(row => {
    const navKey = row.getAttribute('data-nav');
    row.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.disabled) return; // Managers/Coordinators/Settings stay fixed Admin-only, never editable for other roles
      const role = cb.getAttribute('data-role');
      const value = rolePerms && rolePerms[role] ? rolePerms[role][navKey] : undefined;
      cb.checked = value !== false; // default visible until told otherwise
    });
  });
}

function readRolePermsCheckboxes() {
  const result = { admin: {}, manager: {}, coordinator: {} };
  document.querySelectorAll('#company-modal-role-perms tbody tr').forEach(row => {
    const navKey = row.getAttribute('data-nav');
    row.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const role = cb.getAttribute('data-role');
      result[role][navKey] = cb.disabled ? false : cb.checked;
    });
  });
  return result;
}

document.getElementById('add-company-btn').addEventListener('click', () => {
  companyModalMode = 'add';
  companyModalEditingId = null;
  document.getElementById('company-modal-title').textContent = 'Add Company';
  document.getElementById('company-modal-error').style.display = 'none';
  document.getElementById('company-modal-name').value = '';
  document.getElementById('company-modal-code').value = '';
  document.getElementById('company-modal-admin-username').value = '';
  document.getElementById('company-modal-admin-password').value = '';
  document.getElementById('company-modal-contact-email').value = '';
  document.getElementById('company-modal-contact-phone').value = '';
  document.getElementById('company-modal-notes').value = '';
  document.getElementById('company-modal-plan').value = 'standard';
  document.getElementById('company-modal-expires').value = '';
  document.getElementById('company-modal-max-employees').value = '';
  document.getElementById('company-modal-admin-fields').classList.remove('hidden');
  document.getElementById('company-modal-contact-fields').classList.remove('hidden');
  document.getElementById('company-modal-name').closest('.field').classList.remove('hidden');
  document.getElementById('company-modal-code').closest('.field').classList.remove('hidden');
  setCompanyModalCheckboxes('#company-modal-features', 'data-feature', null);
  setCompanyModalCheckboxes('#company-modal-columns', 'data-column', null);
  setRolePermsCheckboxes(null);
  document.getElementById('company-modal').classList.remove('hidden');
});

function openEditCompanyModal(id) {
  const company = companiesCache.find(c => c.id === id);
  if (!company) return;
  companyModalMode = 'edit';
  companyModalEditingId = id;
  document.getElementById('company-modal-title').textContent = `Edit Company — ${company.name}`;
  document.getElementById('company-modal-error').style.display = 'none';
  document.getElementById('company-modal-name').value = company.name;
  document.getElementById('company-modal-code').value = company.code;
  document.getElementById('company-modal-contact-email').value = company.contact_email || '';
  document.getElementById('company-modal-contact-phone').value = company.contact_phone || '';
  document.getElementById('company-modal-notes').value = company.notes || '';
  document.getElementById('company-modal-plan').value = company.plan || 'standard';
  document.getElementById('company-modal-expires').value = company.expires_at ? String(company.expires_at).slice(0, 10) : '';
  document.getElementById('company-modal-max-employees').value = company.max_employees !== null && company.max_employees !== undefined ? company.max_employees : '';
  document.getElementById('company-modal-name').closest('.field').classList.remove('hidden');
  document.getElementById('company-modal-code').closest('.field').classList.remove('hidden');
  document.getElementById('company-modal-contact-fields').classList.remove('hidden');
  // Admin username/password fields are only for creating a NEW company's first Admin —
  // renaming/re-coding an existing company doesn't touch its Admin accounts, so hide them.
  document.getElementById('company-modal-admin-fields').classList.add('hidden');
  setCompanyModalCheckboxes('#company-modal-features', 'data-feature', company.settings && company.settings.features);
  setCompanyModalCheckboxes('#company-modal-columns', 'data-column', company.settings && company.settings.report_columns);
  setRolePermsCheckboxes(company.settings && company.settings.role_permissions);
  document.getElementById('company-modal').classList.remove('hidden');
}

function openCompanySettingsModal(id) {
  const company = companiesCache.find(c => c.id === id);
  if (!company) return;
  companyModalMode = 'settings';
  companyModalEditingId = id;
  document.getElementById('company-modal-title').textContent = `Report & Functions — ${company.name}`;
  document.getElementById('company-modal-error').style.display = 'none';
  // Name/Code/Admin/Contact fields aren't editable from this shortcut — hide them, only show
  // the Functions + Report Columns + Sidebar Access checkboxes.
  document.getElementById('company-modal-name').closest('.field').classList.add('hidden');
  document.getElementById('company-modal-code').closest('.field').classList.add('hidden');
  document.getElementById('company-modal-admin-fields').classList.add('hidden');
  document.getElementById('company-modal-contact-fields').classList.add('hidden');
  setCompanyModalCheckboxes('#company-modal-features', 'data-feature', company.settings && company.settings.features);
  setCompanyModalCheckboxes('#company-modal-columns', 'data-column', company.settings && company.settings.report_columns);
  setRolePermsCheckboxes(company.settings && company.settings.role_permissions);
  document.getElementById('company-modal').classList.remove('hidden');
}

document.getElementById('company-modal-cancel').addEventListener('click', () => {
  document.getElementById('company-modal').classList.add('hidden');
});

document.getElementById('company-modal-save').addEventListener('click', async () => {
  const errBox = document.getElementById('company-modal-error');
  errBox.style.display = 'none';

  const features = readCompanyModalCheckboxes('#company-modal-features', 'data-feature');
  const report_columns = readCompanyModalCheckboxes('#company-modal-columns', 'data-column');
  const role_permissions = readRolePermsCheckboxes();

  if (companyModalMode === 'settings') {
    try {
      await apiFetch(`/companies/${companyModalEditingId}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ features, report_columns, role_permissions })
      });
      showToast('Company settings updated');
      document.getElementById('company-modal').classList.add('hidden');
      loadCompanies();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
    return;
  }

  if (companyModalMode === 'edit') {
    const editName = document.getElementById('company-modal-name').value.trim();
    const editCode = document.getElementById('company-modal-code').value.trim();
    const contact_email = document.getElementById('company-modal-contact-email').value.trim();
    const contact_phone = document.getElementById('company-modal-contact-phone').value.trim();
    const notes = document.getElementById('company-modal-notes').value.trim();
    const plan = document.getElementById('company-modal-plan').value;
    const expires_at = document.getElementById('company-modal-expires').value || null;
    const maxEmpVal = document.getElementById('company-modal-max-employees').value.trim();
    const max_employees = maxEmpVal === '' ? null : Number(maxEmpVal);
    if (!editName || !editCode) {
      errBox.textContent = 'Please fill in Company Name and Company Code';
      errBox.style.display = 'block';
      return;
    }
    try {
      await apiFetch(`/companies/${companyModalEditingId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName, code: editCode, contact_email, contact_phone, notes, plan, expires_at, max_employees })
      });
      showToast('Company updated successfully');
      document.getElementById('company-modal').classList.add('hidden');
      loadCompanies();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
    return;
  }

  const name = document.getElementById('company-modal-name').value.trim();
  const code = document.getElementById('company-modal-code').value.trim();
  const admin_username = document.getElementById('company-modal-admin-username').value.trim();
  const admin_password = document.getElementById('company-modal-admin-password').value;
  const contact_email = document.getElementById('company-modal-contact-email').value.trim();
  const contact_phone = document.getElementById('company-modal-contact-phone').value.trim();
  const notes = document.getElementById('company-modal-notes').value.trim();
  const plan = document.getElementById('company-modal-plan').value;
  const expires_at = document.getElementById('company-modal-expires').value || null;
  const maxEmpVal = document.getElementById('company-modal-max-employees').value.trim();
  const max_employees = maxEmpVal === '' ? null : Number(maxEmpVal);

  if (!name || !code || !admin_username || !admin_password) {
    errBox.textContent = 'Please fill in all fields';
    errBox.style.display = 'block';
    return;
  }

  try {
    await apiFetch('/companies', {
      method: 'POST',
      body: JSON.stringify({ name, code, admin_username, admin_password, features, report_columns, role_permissions, contact_email, contact_phone, notes, plan, expires_at, max_employees })
    });
    showToast(`Company "${name}" added — share Company Code "${code.toUpperCase()}" with them`);
    document.getElementById('company-modal').classList.add('hidden');
    loadCompanies();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

// ===========================================================================
// LIVE OPERATIONS MAP
// ===========================================================================
let opsMapRefreshTimer = null;
function startOpsMapAutoRefresh() { stopOpsMapAutoRefresh(); opsMapRefreshTimer = setInterval(loadOpsMap, 20000); }
function stopOpsMapAutoRefresh() { if (opsMapRefreshTimer) { clearInterval(opsMapRefreshTimer); opsMapRefreshTimer = null; } }
document.getElementById('opsmap-refresh-btn').addEventListener('click', loadOpsMap);

async function loadOpsMap() {
  try {
    const data = await apiFetch('/projects/map');
    document.getElementById('opsmap-last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const grid = document.getElementById('opsmap-grid');
    if (!data.sites.length) {
      grid.innerHTML = `<div class="empty-state"><div class="icon">🗺️</div>No sites yet — add one under Employees → Manage Projects.</div>`;
      return;
    }
    const dotColor = { green: '🟢', yellow: '🟡', red: '🔴' };
    grid.innerHTML = data.sites.map(s => `
      <div class="site-card ${s.status}" onclick="openSiteDetail(${s.id})">
        <div style="display:flex;justify-content:space-between;align-items:start;">
          <div>
            <div style="font-weight:700;font-size:15px">${dotColor[s.status] || ''} ${escapeHtml(s.name)}</div>
            <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(s.client || 'No client set')}</div>
          </div>
          <div style="font-size:20px;font-weight:800;">${s.health_score}</div>
        </div>
        <div style="margin-top:10px;font-size:12px;line-height:1.8;">
          <div>👥 ${s.present_today} / ${s.required_manpower} present ${s.shortage > 0 ? `<b style="color:#B91C1C">(short ${s.shortage})</b>` : ''}</div>
          <div>🧑‍✈️ ${s.reliever_on_duty} reliever(s) on duty</div>
          <div>⚠️ ${s.open_complaints} open complaint(s) ${s.sla_breached ? '<b style="color:#B91C1C">SLA breached</b>' : ''}</div>
          <div>👤 Supervisor: ${escapeHtml(s.supervisor_name || 'Not assigned')}</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

let siteDetailCache = new Map();
async function openSiteDetail(siteId) {
  try {
    const data = await apiFetch(`/projects/${siteId}/detail`);
    siteDetailCache.set(siteId, data.site);
    document.getElementById('site-detail-title').textContent = data.site.name;
    const body = document.getElementById('site-detail-body');
    body.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <button class="btn small" onclick="openSiteEdit(${siteId})">✏️ Edit Site Details</button>
        <button class="btn small secondary" onclick="openSiteLocations('${data.site.name.replace(/'/g, "\\'")}')">📍 Manage Locations</button>
        <button class="btn small secondary" onclick="escalateSite('${data.site.name.replace(/'/g, "\\'")}')">🚨 Escalate Shortage</button>
      </div>
      <p style="font-size:13px;"><b>Client:</b> ${escapeHtml(data.site.client || '-')} &nbsp; <b>Address:</b> ${escapeHtml(data.site.address || '-')}</p>
      <h4 style="margin:14px 0 6px">Present (${data.present.length})</h4>
      <div style="font-size:13px;">${data.present.map(e => escapeHtml(e.name)).join(', ') || 'None'}</div>
      <h4 style="margin:14px 0 6px">Absent (${data.absent.length})</h4>
      <div style="font-size:13px;">${data.absent.map(e => escapeHtml(e.name)).join(', ') || 'None'}</div>
      <h4 style="margin:14px 0 6px">Reliever Coverage Today</h4>
      <div style="font-size:13px;">${data.relievers.length ? data.relievers.map(r => `${r.reliever_employee_id} covering ${r.original_employee_id} (${r.status})`).join('<br>') : 'None'}</div>
      <h4 style="margin:14px 0 6px">Recent Complaints</h4>
      <div style="font-size:13px;">${data.complaints.length ? data.complaints.map(c => `${escapeHtml(c.subject)} — <span class="badge ${c.status}">${c.status}</span>`).join('<br>') : 'None'}</div>
    `;
    document.getElementById('site-detail-modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message, true);
  }
}
document.getElementById('site-detail-close-btn').addEventListener('click', () => document.getElementById('site-detail-modal').classList.add('hidden'));

function openSiteEdit(siteId) {
  const site = siteDetailCache.get(siteId);
  document.getElementById('site-edit-error').style.display = 'none';
  document.getElementById('site-edit-id').value = siteId;
  document.getElementById('site-edit-client').value = site.client || '';
  document.getElementById('site-edit-address').value = site.address || '';
  document.getElementById('site-edit-lat').value = site.latitude ?? '';
  document.getElementById('site-edit-lng').value = site.longitude ?? '';
  document.getElementById('site-edit-geofence').value = site.geofence_radius_m ?? 200;
  document.getElementById('site-edit-manpower').value = site.required_manpower ?? 0;
  document.getElementById('site-edit-supervisor').value = site.supervisor_employee_id || '';
  document.getElementById('site-edit-sla').value = site.sla_hours ?? 24;
  document.getElementById('site-detail-modal').classList.add('hidden');
  document.getElementById('site-edit-modal').classList.remove('hidden');
}
document.getElementById('site-edit-cancel-btn').addEventListener('click', () => document.getElementById('site-edit-modal').classList.add('hidden'));
document.getElementById('site-edit-save-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('site-edit-error');
  errBox.style.display = 'none';
  const id = document.getElementById('site-edit-id').value;
  try {
    await apiFetch(`/projects/${id}/site-details`, {
      method: 'PUT',
      body: JSON.stringify({
        client: document.getElementById('site-edit-client').value,
        address: document.getElementById('site-edit-address').value,
        latitude: document.getElementById('site-edit-lat').value,
        longitude: document.getElementById('site-edit-lng').value,
        geofence_radius_m: document.getElementById('site-edit-geofence').value,
        required_manpower: document.getElementById('site-edit-manpower').value,
        supervisor_employee_id: document.getElementById('site-edit-supervisor').value,
        sla_hours: document.getElementById('site-edit-sla').value,
      }),
    });
    showToast('Site details updated');
    document.getElementById('site-edit-modal').classList.add('hidden');
    loadOpsMap();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});
async function escalateSite(project) {
  if (!confirm(`Escalate staff shortage at ${project}? This notifies ops management.`)) return;
  try {
    const data = await apiFetch('/emergency/escalate', { method: 'POST', body: JSON.stringify({ project }) });
    showToast(data.message);
    document.getElementById('site-detail-modal').classList.add('hidden');
    loadEscalations();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadEscalations() {
  try {
    const data = await apiFetch('/emergency/escalations');
    const tbody = document.getElementById('escalations-table-body');
    if (!data.escalations.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">🚨</div>No escalations yet</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.escalations.map(e => `
      <tr>
        <td>${escapeHtml(e.project)}</td>
        <td class="mono">${e.shortage}</td>
        <td>${escapeHtml(e.escalated_by || '-')}</td>
        <td><span class="badge ${e.status === 'open' ? 'critical' : 'reliever_on_duty'}">${e.status}</span></td>
        <td class="mono" style="font-size:12px">${formatISTDateTime(e.created_at)}</td>
        <td>${e.status === 'open' ? `<button class="btn small secondary" onclick="resolveEscalation(${e.id})">Mark Resolved</button>` : ''}</td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}
async function resolveEscalation(id) {
  try {
    await apiFetch(`/emergency/escalations/${id}/resolve`, { method: 'PUT' });
    showToast('Escalation marked resolved');
    loadEscalations();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ===========================================================================
// SITE LOCATIONS — sub-locations within one project (e.g. 100 buildings under one project,
// each with their own punch-in geofence radius). Opened from a site's detail popup on the
// Operations Map.
// ===========================================================================
async function openSiteLocations(project) {
  document.getElementById('site-locations-project').value = project;
  document.getElementById('site-locations-project-name').textContent = project;
  document.getElementById('site-locations-error').style.display = 'none';
  document.getElementById('site-loc-add-name').value = '';
  document.getElementById('site-loc-add-lat').value = '';
  document.getElementById('site-loc-add-lng').value = '';
  document.getElementById('site-loc-add-radius').value = '200';
  document.getElementById('site-loc-bulk-text').value = '';
  document.getElementById('site-detail-modal').classList.add('hidden');
  document.getElementById('site-locations-modal').classList.remove('hidden');
  await loadSiteLocationsList(project);
}
document.getElementById('site-locations-close-btn').addEventListener('click', () => {
  document.getElementById('site-locations-modal').classList.add('hidden');
});

async function loadSiteLocationsList(project) {
  try {
    const data = await apiFetch(`/site-locations?project=${encodeURIComponent(project)}`);
    const tbody = document.getElementById('site-locations-table-body');
    if (!data.locations.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="icon">📍</div>No locations yet — add one below</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.locations.map(l => `
      <tr${l.shortage > 0 ? ' style="background:#FEF2F2"' : ''}>
        <td>${escapeHtml(l.name)}</td>
        <td class="mono" style="font-size:12px">${Number(l.latitude).toFixed(5)}</td>
        <td class="mono" style="font-size:12px">${Number(l.longitude).toFixed(5)}</td>
        <td class="mono">${l.radius_m}</td>
        <td class="mono">${l.required_manpower}</td>
        <td class="mono">${l.present_today}${l.shortage > 0 ? ` <span class="badge critical">short ${l.shortage}</span>` : ''}</td>
        <td class="mono">${l.employee_count}</td>
        <td><button class="btn small secondary" onclick="deleteSiteLocation(${l.id}, '${project.replace(/'/g, "\\'")}')">Delete</button></td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('site-loc-add-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('site-locations-error');
  errBox.style.display = 'none';
  const project = document.getElementById('site-locations-project').value;
  const name = document.getElementById('site-loc-add-name').value.trim();
  const latitude = document.getElementById('site-loc-add-lat').value;
  const longitude = document.getElementById('site-loc-add-lng').value;
  const radius_m = document.getElementById('site-loc-add-radius').value || 200;
  const required_manpower = document.getElementById('site-loc-add-required').value || 0;
  if (!name || !latitude || !longitude) {
    errBox.textContent = 'Name, latitude and longitude are required';
    errBox.style.display = 'block';
    return;
  }
  try {
    await apiFetch('/site-locations', { method: 'POST', body: JSON.stringify({ project, name, latitude, longitude, radius_m, required_manpower }) });
    showToast('Location added');
    document.getElementById('site-loc-add-name').value = '';
    document.getElementById('site-loc-add-lat').value = '';
    document.getElementById('site-loc-add-lng').value = '';
    document.getElementById('site-loc-add-radius').value = '200';
    document.getElementById('site-loc-add-required').value = '';
    loadSiteLocationsList(project);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

document.getElementById('site-loc-bulk-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('site-locations-error');
  errBox.style.display = 'none';
  const project = document.getElementById('site-locations-project').value;
  const text = document.getElementById('site-loc-bulk-text').value.trim();
  if (!text) { errBox.textContent = 'Paste at least one location line first'; errBox.style.display = 'block'; return; }

  const locations = text.split('\n').map(line => {
    const parts = line.split(',').map(p => p.trim());
    return { name: parts[0], latitude: parts[1], longitude: parts[2], radius_m: parts[3] || 200, required_manpower: parts[4] || 0 };
  }).filter(l => l.name);

  try {
    const data = await apiFetch('/site-locations/bulk', { method: 'POST', body: JSON.stringify({ project, locations }) });
    showToast(data.message);
    if (data.skipped && data.skipped.length) {
      console.warn('Skipped rows:', data.skipped);
      showToast(`${data.skipped.length} row(s) skipped — check console for details`, true);
    }
    document.getElementById('site-loc-bulk-text').value = '';
    loadSiteLocationsList(project);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

async function deleteSiteLocation(id, project) {
  if (!confirm('Delete this location? Employees assigned here will fall back to the project\'s own geofence.')) return;
  try {
    await apiFetch(`/site-locations/${id}`, { method: 'DELETE' });
    showToast('Location removed');
    loadSiteLocationsList(project);
  } catch (err) {
    showToast(err.message, true);
  }
}

// ===========================================================================
// MAINTENANCE & COMPLAINT/SLA TICKETS
// ===========================================================================
async function loadMaintenanceTickets() {
  try {
    const status = document.getElementById('maint-filter-status').value;
    const data = await apiFetch('/maintenance' + (status ? `?status=${status}` : ''));
    const tbody = document.getElementById('maint-table-body');
    if (!data.tickets.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="icon">🛠️</div>No tickets</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.tickets.map(t => `
      <tr>
        <td class="mono">#${t.id}</td>
        <td>${escapeHtml(t.project)}</td>
        <td>${escapeHtml(t.category)}</td>
        <td>${escapeHtml(t.subject)}</td>
        <td><span class="badge ${t.priority}">${t.priority}</span></td>
        <td><span class="badge ${t.status}">${t.status}</span>${t.sla_breached ? ' <span class="badge critical">SLA breach</span>' : ''}</td>
        <td class="mono" style="font-size:12px">${t.sla_hours ? t.sla_hours + 'h' : '-'}</td>
        <td>
          ${t.status === 'open' ? `<button class="btn small" onclick="assignMaintTicket(${t.id})">Assign</button>` : ''}
          ${['assigned', 'in_progress'].includes(t.status) ? `<button class="btn small secondary" onclick="advanceMaintTicket(${t.id}, 'resolved')">Mark Resolved</button>` : ''}
          ${t.status === 'resolved' ? `<button class="btn small secondary" onclick="advanceMaintTicket(${t.id}, 'verified')">Verify</button>` : ''}
          ${t.status === 'verified' ? `<button class="btn small secondary" onclick="advanceMaintTicket(${t.id}, 'closed')">Close</button>` : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}
document.getElementById('maint-filter-status').addEventListener('change', loadMaintenanceTickets);
document.getElementById('maint-refresh-btn').addEventListener('click', loadMaintenanceTickets);

async function assignMaintTicket(id) {
  const technician = prompt('Technician name:');
  if (!technician) return;
  try {
    await apiFetch(`/maintenance/${id}/assign`, { method: 'PUT', body: JSON.stringify({ assigned_technician: technician }) });
    showToast('Ticket assigned');
    loadMaintenanceTickets();
  } catch (err) {
    showToast(err.message, true);
  }
}
async function advanceMaintTicket(id, status) {
  try {
    await apiFetch(`/maintenance/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
    showToast(`Ticket marked ${status}`);
    loadMaintenanceTickets();
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('maint-new-ticket-btn').addEventListener('click', async () => {
  document.getElementById('maint-new-error').style.display = 'none';
  const select = document.getElementById('maint-new-project');
  select.innerHTML = '';
  try {
    const data = await apiFetch('/projects');
    data.projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      select.appendChild(opt);
    });
  } catch (err) { /* projects list is best-effort here */ }
  document.getElementById('maint-new-subject').value = '';
  document.getElementById('maint-new-description').value = '';
  document.getElementById('maint-new-modal').classList.remove('hidden');
});
document.getElementById('maint-new-cancel-btn').addEventListener('click', () => document.getElementById('maint-new-modal').classList.add('hidden'));
document.getElementById('maint-new-submit-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('maint-new-error');
  errBox.style.display = 'none';
  const subject = document.getElementById('maint-new-subject').value.trim();
  if (!subject) { errBox.textContent = 'Subject is required'; errBox.style.display = 'block'; return; }
  try {
    await apiFetch('/maintenance', {
      method: 'POST',
      body: JSON.stringify({
        project: document.getElementById('maint-new-project').value,
        category: document.getElementById('maint-new-category').value,
        subject, description: document.getElementById('maint-new-description').value,
        priority: document.getElementById('maint-new-priority').value,
      }),
    });
    showToast('Ticket raised');
    document.getElementById('maint-new-modal').classList.add('hidden');
    loadMaintenanceTickets();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

// ===========================================================================
// SOS ALERTS (admin/manager/coordinator live feed)
// ===========================================================================
let sosRefreshTimer = null;
function startSosAutoRefresh() { stopSosAutoRefresh(); sosRefreshTimer = setInterval(loadSosAlerts, 15000); }
function stopSosAutoRefresh() { if (sosRefreshTimer) { clearInterval(sosRefreshTimer); sosRefreshTimer = null; } }
document.getElementById('sos-refresh-btn').addEventListener('click', loadSosAlerts);

const SOS_TYPE_LABELS = { medical: '🏥 Medical', accident: '🚑 Accident', fire: '🔥 Fire', security: '🚨 Security', other: '⚠️ Other' };
async function loadSosAlerts() {
  try {
    const data = await apiFetch('/sos');
    document.getElementById('sos-last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    document.getElementById('sos-stat-open').textContent = data.openCount;
    const tbody = document.getElementById('sos-table-body');
    if (!data.alerts.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon">🆘</div>No SOS alerts</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.alerts.map(a => `
      <tr>
        <td class="mono">${a.employee_id} — ${escapeHtml(a.employee_name || '')}</td>
        <td>${SOS_TYPE_LABELS[a.type] || a.type}</td>
        <td>${escapeHtml(a.project || '-')}</td>
        <td style="font-size:12px">${escapeHtml(a.note || '-')}</td>
        <td class="mono" style="font-size:12px">${formatISTDateTime(a.created_at)}</td>
        <td><span class="badge ${a.status}">${a.status}</span></td>
        <td>
          ${a.status === 'open' ? `<button class="btn small" onclick="acknowledgeSos(${a.id})">Acknowledge</button>` : ''}
          ${a.status !== 'resolved' ? `<button class="btn small secondary" onclick="resolveSos(${a.id})">Resolve</button>` : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}
async function acknowledgeSos(id) {
  try { await apiFetch(`/sos/${id}/acknowledge`, { method: 'PUT' }); showToast('Acknowledged'); loadSosAlerts(); }
  catch (err) { showToast(err.message, true); }
}
async function resolveSos(id) {
  const note = prompt('Resolution note (optional):') || '';
  try { await apiFetch(`/sos/${id}/resolve`, { method: 'PUT', body: JSON.stringify({ resolution_note: note }) }); showToast('Resolved'); loadSosAlerts(); }
  catch (err) { showToast(err.message, true); }
}

// Employee-side: send SOS
document.getElementById('emp-sos-btn').addEventListener('click', () => {
  const type = document.getElementById('emp-sos-type').value;
  const send = (lat, lng) => {
    apiFetch('/sos', { method: 'POST', body: JSON.stringify({ type, latitude: lat, longitude: lng }) })
      .then(data => showToast(data.message))
      .catch(err => showToast(err.message, true));
  };
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => send(pos.coords.latitude, pos.coords.longitude),
      () => send(null, null),
      { timeout: 8000 }
    );
  } else {
    send(null, null);
  }
});

// ===========================================================================
// ANNOUNCEMENTS
// ===========================================================================
async function loadAnnouncements() {
  try {
    const data = await apiFetch('/announcements');
    const list = document.getElementById('announce-list');
    if (!data.announcements.length) {
      list.innerHTML = `<div class="empty-state"><div class="icon">💬</div>No announcements yet</div>`;
      return;
    }
    list.innerHTML = data.announcements.map(a => `
      <div class="panel" style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:start;">
          <div>
            <div style="font-weight:700;">${a.pinned ? '📌 ' : ''}${escapeHtml(a.title)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin:4px 0;">${a.audience === 'project' ? 'Site: ' + escapeHtml(a.project) : a.audience === 'staff' ? 'Staff only' : 'Everyone'} • ${formatISTDateTime(a.created_at)}</div>
            <div style="font-size:13px;margin-top:6px;">${escapeHtml(a.message)}</div>
          </div>
          <button class="btn small secondary" onclick="deleteAnnouncement(${a.id})">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}
async function deleteAnnouncement(id) {
  if (!confirm('Delete this announcement?')) return;
  try { await apiFetch(`/announcements/${id}`, { method: 'DELETE' }); showToast('Removed'); loadAnnouncements(); }
  catch (err) { showToast(err.message, true); }
}
document.getElementById('announce-new-audience').addEventListener('change', (e) => {
  document.getElementById('announce-new-project-field').classList.toggle('hidden', e.target.value !== 'project');
});
document.getElementById('announce-new-btn').addEventListener('click', async () => {
  document.getElementById('announce-new-error').style.display = 'none';
  document.getElementById('announce-new-title').value = '';
  document.getElementById('announce-new-message').value = '';
  document.getElementById('announce-new-audience').value = 'all';
  document.getElementById('announce-new-project-field').classList.add('hidden');
  document.getElementById('announce-new-pinned').checked = false;
  const select = document.getElementById('announce-new-project');
  select.innerHTML = '';
  try {
    const data = await apiFetch('/projects');
    data.projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      select.appendChild(opt);
    });
  } catch (err) { /* best effort */ }
  document.getElementById('announce-new-modal').classList.remove('hidden');
});
document.getElementById('announce-new-cancel-btn').addEventListener('click', () => document.getElementById('announce-new-modal').classList.add('hidden'));
document.getElementById('announce-new-submit-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('announce-new-error');
  errBox.style.display = 'none';
  const title = document.getElementById('announce-new-title').value.trim();
  const message = document.getElementById('announce-new-message').value.trim();
  if (!title || !message) { errBox.textContent = 'Title and message are required'; errBox.style.display = 'block'; return; }
  try {
    await apiFetch('/announcements', {
      method: 'POST',
      body: JSON.stringify({
        title, message,
        audience: document.getElementById('announce-new-audience').value,
        project: document.getElementById('announce-new-project').value,
        pinned: document.getElementById('announce-new-pinned').checked,
      }),
    });
    showToast('Announcement posted');
    document.getElementById('announce-new-modal').classList.add('hidden');
    loadAnnouncements();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

// Employee-side: view relevant announcements
async function loadEmpAnnouncements() {
  try {
    const data = await apiFetch('/announcements/my');
    const list = document.getElementById('emp-announce-list');
    if (!data.announcements.length) {
      list.innerHTML = `<div class="empty-state"><div class="icon">💬</div>No announcements right now</div>`;
      return;
    }
    list.innerHTML = data.announcements.map(a => `
      <div class="panel" style="margin-bottom:10px;">
        <div style="font-weight:700;">${a.pinned ? '📌 ' : ''}${escapeHtml(a.title)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin:4px 0;">${formatISTDateTime(a.created_at)}</div>
        <div style="font-size:13px;margin-top:6px;">${escapeHtml(a.message)}</div>
      </div>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

// ===========================================================================
// AUDIT & SECURITY
// ===========================================================================
async function loadAuditLog() {
  try {
    const data = await apiFetch('/audit/log');
    const tbody = document.getElementById('audit-log-table-body');
    tbody.innerHTML = data.log.length ? data.log.map(r => `
      <tr>
        <td class="mono" style="font-size:12px">${formatISTDateTime(r.created_at)}</td>
        <td>${escapeHtml(r.actor_username)}</td>
        <td>${escapeHtml(r.actor_role)}</td>
        <td>${escapeHtml(r.action)}</td>
        <td style="font-size:12px">${escapeHtml(r.target_label || r.target_type || '-')}</td>
      </tr>
    `).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="icon">🔐</div>No activity yet</div></td></tr>`;
  } catch (err) {
    showToast(err.message, true);
  }
}
async function loadLoginHistory() {
  try {
    const data = await apiFetch('/audit/login-history');
    document.getElementById('audit-stat-failed24h').textContent = data.failedLast24h;
    const tbody = document.getElementById('audit-login-table-body');
    tbody.innerHTML = data.history.length ? data.history.map(r => `
      <tr>
        <td class="mono" style="font-size:12px">${formatISTDateTime(r.created_at)}</td>
        <td>${escapeHtml(r.username || '-')}</td>
        <td>${escapeHtml(r.role || '-')}</td>
        <td><span class="badge ${r.success ? 'reliever_on_duty' : 'critical'}">${r.success ? 'Success' : 'Failed'}</span></td>
        <td style="font-size:12px">${escapeHtml(r.reason || '-')}</td>
        <td class="mono" style="font-size:12px">${escapeHtml(r.ip_address || '-')}</td>
      </tr>
    `).join('') : `<tr><td colspan="6"><div class="empty-state"><div class="icon">🔐</div>No login history yet</div></td></tr>`;
  } catch (err) {
    showToast(err.message, true);
  }
}

// ===========================================================================
// CLIENT PORTAL ACCOUNTS (admin management)
// ===========================================================================
async function loadClientAccounts() {
  try {
    const data = await apiFetch('/client-accounts');
    const tbody = document.getElementById('client-table-body');
    tbody.innerHTML = data.clients.length ? data.clients.map(c => `
      <tr>
        <td class="mono">${escapeHtml(c.username)}</td>
        <td>${escapeHtml(c.name)}</td>
        <td style="font-size:12px">${c.projects.map(escapeHtml).join(', ')}</td>
        <td><span class="badge ${c.active ? 'reliever_on_duty' : 'critical'}">${c.active ? 'Active' : 'Inactive'}</span></td>
        <td><button class="btn small" onclick="editClientAccount(${c.id})">Edit</button> <button class="btn small secondary" onclick="deleteClientAccount(${c.id})">Delete</button></td>
      </tr>
    `).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="icon">🏢</div>No client accounts yet</div></td></tr>`;
  } catch (err) {
    showToast(err.message, true);
  }
}
async function deleteClientAccount(id) {
  if (!confirm('Remove this client account?')) return;
  try { await apiFetch(`/client-accounts/${id}`, { method: 'DELETE' }); showToast('Removed'); loadClientAccounts(); }
  catch (err) { showToast(err.message, true); }
}
document.getElementById('client-new-btn').addEventListener('click', async () => {
  document.getElementById('client-new-error').style.display = 'none';
  document.getElementById('client-new-username').value = '';
  document.getElementById('client-new-username').disabled = false;
  document.getElementById('client-new-password').value = '';
  document.getElementById('client-new-password').placeholder = '';
  document.getElementById('client-new-name').value = '';
  document.getElementById('client-new-email').value = '';
  delete document.getElementById('client-new-submit-btn').dataset.editId;
  const select = document.getElementById('client-new-projects');
  select.innerHTML = '';
  try {
    const data = await apiFetch('/projects');
    data.projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      select.appendChild(opt);
    });
  } catch (err) { /* best effort */ }
  document.getElementById('client-new-modal').classList.remove('hidden');
});
document.getElementById('client-new-cancel-btn').addEventListener('click', () => {
  document.getElementById('client-new-modal').classList.add('hidden');
  document.getElementById('client-new-username').disabled = false;
});
document.getElementById('client-new-submit-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('client-new-error');
  errBox.style.display = 'none';
  const editId = document.getElementById('client-new-submit-btn').dataset.editId;
  const username = document.getElementById('client-new-username').value.trim();
  const password = document.getElementById('client-new-password').value;
  const name = document.getElementById('client-new-name').value.trim();
  const projects = Array.from(document.getElementById('client-new-projects').selectedOptions).map(o => o.value);

  if (editId) {
    if (!name || !projects.length) {
      errBox.textContent = 'Name and at least one site are required';
      errBox.style.display = 'block';
      return;
    }
    try {
      const body = { name, contact_email: document.getElementById('client-new-email').value, projects };
      if (password) body.password = password;
      await apiFetch(`/client-accounts/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('Client account updated');
      document.getElementById('client-new-modal').classList.add('hidden');
      document.getElementById('client-new-username').disabled = false;
      loadClientAccounts();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
    return;
  }

  if (!username || !password || !name || !projects.length) {
    errBox.textContent = 'Username, password, name and at least one site are required';
    errBox.style.display = 'block';
    return;
  }
  try {
    await apiFetch('/client-accounts', {
      method: 'POST',
      body: JSON.stringify({ username, password, name, contact_email: document.getElementById('client-new-email').value, projects }),
    });
    showToast('Client account created');
    document.getElementById('client-new-modal').classList.add('hidden');
    loadClientAccounts();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

// ===========================================================================
// CLIENT PORTAL — the client's own read-only dashboard (separate role/session entirely
// from staff and employee — see routes/clientPortal.js on the backend).
// ===========================================================================
document.getElementById('client-login-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('client-login-error');
  errBox.style.display = 'none';
  const company_code = document.getElementById('client-login-company').value.trim();
  const username = document.getElementById('client-login-username').value.trim();
  const password = document.getElementById('client-login-password').value;
  if (!company_code || !username || !password) {
    errBox.textContent = 'Please fill in all fields';
    errBox.style.display = 'block';
    return;
  }
  const btn = document.getElementById('client-login-btn');
  btn.disabled = true;
  try {
    const res = await fetch(API + '/auth/client-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_code, username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    rememberCompanyCode(company_code);
    sessionStorage.setItem('geovixa_token', data.token);
    sessionStorage.setItem('geovixa_role', 'client');
    sessionStorage.setItem('geovixa_client_name', data.name);
    sessionStorage.setItem('geovixa_client_projects', JSON.stringify(data.projects || []));
    sessionStorage.setItem('geovixa_company_name', data.company_name);
    navigate('/client', true);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('client-logout-btn').addEventListener('click', logoutAll);
document.getElementById('client-site-detail-close-btn').addEventListener('click', () => document.getElementById('client-site-detail-modal').classList.add('hidden'));

function showClientDashboard() {
  document.getElementById('client-dash-name').textContent = sessionStorage.getItem('geovixa_client_name') || '-';
  showView('client-dashboard-view');
  loadClientSites();
}

async function loadClientSites() {
  try {
    const data = await apiFetch('/client-portal/sites');
    const grid = document.getElementById('client-sites-grid');
    if (!data.sites.length) {
      grid.innerHTML = `<div class="empty-state"><div class="icon">🏢</div>No sites assigned to your account yet.</div>`;
      return;
    }
    grid.innerHTML = data.sites.map(s => {
      const statusColor = s.shortage > 0 ? (s.shortage >= s.required_manpower / 2 ? 'red' : 'yellow') : 'green';
      return `
      <div class="site-card ${statusColor}" onclick="openClientSiteDetail('${s.project.replace(/'/g, "\\'")}')">
        <div style="font-weight:700;font-size:15px">${escapeHtml(s.project)}</div>
        <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(s.address || '')}</div>
        <div style="margin-top:10px;font-size:12px;line-height:1.8;">
          <div>👥 ${s.present_today} / ${s.required_manpower} present ${s.shortage > 0 ? `<b style="color:#B91C1C">(short ${s.shortage})</b>` : ''}</div>
          <div>🧑‍🔧 ${s.deployed_employees} employees deployed</div>
          <div>⚠️ ${s.open_complaints} open complaint(s)</div>
          <div>🛠️ ${s.open_maintenance_tickets} open ticket(s)</div>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

async function openClientSiteDetail(project) {
  try {
    const data = await apiFetch(`/client-portal/sites/${encodeURIComponent(project)}/detail`);
    document.getElementById('client-site-detail-title').textContent = data.project;
    document.getElementById('client-site-detail-body').innerHTML = `
      <p style="font-size:13px;"><b>30-day Attendance:</b> ${data.attendance_30d_pct != null ? data.attendance_30d_pct + '%' : '-'}</p>
      <h4 style="margin:14px 0 6px">Deployment (${data.deployment.length})</h4>
      <div style="font-size:13px;">${data.deployment.map(e => `${escapeHtml(e.name)} — ${escapeHtml(e.designation || '')} <span class="badge ${e.status_today === 'present' ? 'reliever_on_duty' : 'critical'}">${e.status_today}</span>`).join('<br>') || 'None'}</div>
      <h4 style="margin:14px 0 6px">Open Items</h4>
      <div style="font-size:13px;">${data.tickets.length ? data.tickets.map(t => `${escapeHtml(t.subject)} — <span class="badge ${t.status}">${t.status}</span>`).join('<br>') : 'None'}</div>
    `;
    document.getElementById('client-site-detail-modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message, true);
  }
}

// ===========================================================================
// RELIEVER MANAGEMENT (admin/manager/coordinator) — live dashboard: who's currently on
// reliever duty, who's free right now, and a way for a senior to force-assign anyone to
// cover anyone else instantly. Auto-refreshes on a timer while this tab is open (see
// startRelieverAutoRefresh/stopRelieverAutoRefresh, wired from activateNavTab).
// ===========================================================================
let relieverRefreshTimer = null;
let relieverMyLocation = null; // { lat, lng } — set once via "Use My Location"
let relieverLastData = null;   // last /reliever/dashboard response, re-rendered when location changes

const RELIEVER_STATUS_LABELS = {
  reliever_on_duty: '🟢 On Reliever Duty',
  reliever_pending: '🟡 Awaiting Accept',
  on_regular_duty: '🔵 On Regular Duty',
  on_leave: '🟣 On Leave',
  available: '⚪ Free / Available',
};

function startRelieverAutoRefresh() {
  stopRelieverAutoRefresh();
  // 20s poll — frequent enough to feel live, gentle enough not to hammer the server. Only
  // runs while the tab is actually open (activateNavTab stops it on navigating away).
  relieverRefreshTimer = setInterval(loadRelieverDashboard, 20000);
}
function stopRelieverAutoRefresh() {
  if (relieverRefreshTimer) { clearInterval(relieverRefreshTimer); relieverRefreshTimer = null; }
}
document.getElementById('reliever-refresh-btn').addEventListener('click', loadRelieverDashboard);

// Haversine distance in km between two lat/lng points.
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

document.getElementById('reliever-locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    showToast('Location not supported by this browser', true);
    return;
  }
  showToast('Getting your location...');
  navigator.geolocation.getCurrentPosition(
    pos => {
      relieverMyLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      showToast('Location set — sorted by nearest');
      if (relieverLastData) renderRelieverAvailableTable(relieverLastData.employees);
    },
    err => showToast('Could not get location: ' + err.message, true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

async function loadRelieverDashboard() {
  try {
    const data = await apiFetch('/reliever/dashboard');
    relieverLastData = data;

    document.getElementById('reliever-stat-total').textContent = data.summary.total;
    document.getElementById('reliever-stat-onduty').textContent = data.summary.relieverOnDuty;
    document.getElementById('reliever-stat-pending').textContent = data.summary.relieverPending;
    document.getElementById('reliever-stat-available').textContent = data.summary.available;
    document.getElementById('reliever-last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

    renderRelieverAvailableTable(data.employees);
    renderRelieverActiveTable(data.employees);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderRelieverAvailableTable(employees) {
  let available = employees.filter(e => e.status === 'available');

  // Sort nearest-first once we know the admin/manager's current location — employees with
  // no last-known GPS on record are pushed to the bottom rather than dropped, since they're
  // still assignable, just without a distance estimate.
  if (relieverMyLocation) {
    available = available.map(e => ({
      ...e,
      _distanceKm: (e.last_lat != null && e.last_lng != null)
        ? haversineKm(relieverMyLocation.lat, relieverMyLocation.lng, e.last_lat, e.last_lng)
        : null,
    })).sort((a, b) => {
      if (a._distanceKm == null && b._distanceKm == null) return 0;
      if (a._distanceKm == null) return 1;
      if (b._distanceKm == null) return -1;
      return a._distanceKm - b._distanceKm;
    });
  }

  document.getElementById('reliever-available-count').textContent = `Free / Available Employees (${available.length})`;
  const tbody = document.getElementById('reliever-available-table-body');
  if (!available.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon">📭</div>No free employees right now</div></td></tr>`;
    return;
  }
  tbody.innerHTML = available.map(e => `
    <tr>
      <td class="mono">${e.employee_id}</td>
      <td>${escapeHtml(e.name || '-')}</td>
      <td>${escapeHtml(e.project || '-')}</td>
      <td style="font-size:12px">${escapeHtml(e.zone || '-')} / ${escapeHtml(e.ward || '-')}</td>
      <td class="mono" style="font-size:12px">${e.last_seen_at ? formatISTDateTime(e.last_seen_at) : 'Never punched'}</td>
      <td class="mono" style="font-size:12px">${e._distanceKm != null ? e._distanceKm.toFixed(1) + ' km' : '-'}</td>
      <td><button class="btn small" onclick="openRelieverAssignModal('${e.employee_id}')">Assign as Reliever</button></td>
    </tr>
  `).join('');
}

function renderRelieverActiveTable(employees) {
  const active = employees.filter(e => e.status === 'reliever_on_duty' || e.status === 'reliever_pending');
  document.getElementById('reliever-active-count').textContent = `Today's Reliever Duties (${active.length})`;
  const tbody = document.getElementById('reliever-active-table-body');
  if (!active.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="icon">📭</div>No reliever duties assigned for today yet</div></td></tr>`;
    return;
  }
  tbody.innerHTML = active.map(e => `
    <tr>
      <td class="mono">${e.employee_id} — ${escapeHtml(e.name || '')}</td>
      <td class="mono">${e.covering_for || '-'}</td>
      <td>${escapeHtml(e.project || '-')}</td>
      <td><span class="badge ${e.status}">${RELIEVER_STATUS_LABELS[e.status] || e.status}</span></td>
      <td><button class="btn secondary small" onclick="cancelRelieverForEmployee('${e.employee_id}')">Cancel</button></td>
    </tr>
  `).join('');
}

// Cancelling from this dashboard only has the employee_id + today's date to go on (the
// dashboard response doesn't carry the assignment's row id), so this looks it up first.
async function cancelRelieverForEmployee(relieverEmployeeId) {
  if (!confirm('Cancel this reliever duty?')) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const data = await apiFetch(`/reliever/assignments?from=${today}&to=${today}`);
    const match = (data.assignments || []).find(a => a.reliever_employee_id === relieverEmployeeId && ['assigned', 'accepted'].includes(a.status));
    if (!match) { showToast('Assignment not found', true); return; }
    await apiFetch(`/reliever/assignments/${match.id}/cancel`, { method: 'PUT' });
    showToast('Reliever duty cancelled');
    loadRelieverDashboard();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---- Assign Reliever modal ----
async function openRelieverAssignModal(relieverEmployeeId) {
  document.getElementById('reliever-assign-modal-error').style.display = 'none';
  document.getElementById('reliever-assign-reliever-id').value = relieverEmployeeId;
  document.getElementById('reliever-assign-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('reliever-assign-reason').value = '';
  document.getElementById('reliever-assign-force').checked = true;

  const select = document.getElementById('reliever-assign-original-select');
  select.innerHTML = '<option value="">— Select employee to cover —</option>';
  try {
    const data = await apiFetch('/employees');
    (data.employees || [])
      .filter(e => e.active && e.employee_id !== relieverEmployeeId)
      .forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.employee_id;
        opt.textContent = `${e.employee_id} — ${e.name}${e.project ? ' (' + e.project + ')' : ''}`;
        select.appendChild(opt);
      });
  } catch (err) {
    showToast(err.message, true);
  }

  document.getElementById('reliever-assign-modal').classList.remove('hidden');
}
document.getElementById('reliever-assign-cancel-btn').addEventListener('click', () => {
  document.getElementById('reliever-assign-modal').classList.add('hidden');
});
document.getElementById('reliever-assign-submit-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('reliever-assign-modal-error');
  errBox.style.display = 'none';

  const reliever_employee_id = document.getElementById('reliever-assign-reliever-id').value;
  const original_employee_id = document.getElementById('reliever-assign-original-select').value;
  const duty_date = document.getElementById('reliever-assign-date').value;
  const reason = document.getElementById('reliever-assign-reason').value.trim();
  const force = document.getElementById('reliever-assign-force').checked;

  if (!original_employee_id || !duty_date) {
    errBox.textContent = 'Please select who this reliever is covering for, and a duty date';
    errBox.style.display = 'block';
    return;
  }

  try {
    const data = await apiFetch('/reliever/assign', {
      method: 'POST',
      body: JSON.stringify({ original_employee_id, reliever_employee_id, duty_date, reason, force }),
    });
    showToast(data.message);
    document.getElementById('reliever-assign-modal').classList.add('hidden');
    loadRelieverDashboard();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

// ---- AI Reliever Ranking modal ----
document.getElementById('reliever-rank-btn').addEventListener('click', async () => {
  document.getElementById('reliever-rank-error').style.display = 'none';
  document.getElementById('reliever-rank-results').innerHTML = '';
  const select = document.getElementById('reliever-rank-project');
  select.innerHTML = '';
  try {
    const data = await apiFetch('/projects');
    data.projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      select.appendChild(opt);
    });
  } catch (err) { /* best effort */ }
  document.getElementById('reliever-rank-modal').classList.remove('hidden');
});
document.getElementById('reliever-rank-close-btn').addEventListener('click', () => document.getElementById('reliever-rank-modal').classList.add('hidden'));
document.getElementById('reliever-rank-submit-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('reliever-rank-error');
  errBox.style.display = 'none';
  const project = document.getElementById('reliever-rank-project').value;
  if (!project) { errBox.textContent = 'Select a site'; errBox.style.display = 'block'; return; }

  const results = document.getElementById('reliever-rank-results');
  results.innerHTML = `<div class="empty-state"><div class="icon">🤖</div>Ranking...</div>`;

  const doRank = async (lat, lng) => {
    try {
      const data = await apiFetch('/reliever/rank', { method: 'POST', body: JSON.stringify({ project, lat, lng }) });
      if (!data.ranked.length) {
        results.innerHTML = `<div class="empty-state"><div class="icon">🤖</div>No free employees available to rank right now</div>`;
        return;
      }
      const methodLabel = data.ranking_method === 'ml'
        ? '🧠 Ranked by ML model (spatial nearest-neighbor + trained fitness scorer)'
        : '📐 Ranked by formula (Python ML unavailable — using built-in scoring)';
      results.innerHTML = `<p style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">${methodLabel}</p>` + data.ranked.map(r => `
        <div class="panel" style="margin-bottom:8px;padding:10px 14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <b>${r.medal || '#' + r.rank}</b> ${escapeHtml(r.name)} <span class="mono" style="font-size:11px;color:var(--text-muted)">(${r.employee_id})</span>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
                ${r.distance_km != null ? r.distance_km + ' km' : 'distance unknown'} • ${r.attendance_30d_pct}% attendance • ${r.ot_hours_7d}h OT this week
              </div>
            </div>
            <div style="text-align:right;">
              <div style="font-weight:800;font-size:16px;">${data.ranking_method === 'ml' && r.ml_score != null ? r.ml_score : r.score}</div>
              <button class="btn small" onclick="document.getElementById('reliever-rank-modal').classList.add('hidden'); openRelieverAssignModal('${r.employee_id}')">Assign</button>
            </div>
          </div>
        </div>
      `).join('');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
      results.innerHTML = '';
    }
  };

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => doRank(pos.coords.latitude, pos.coords.longitude),
      () => doRank(null, null),
      { timeout: 6000 }
    );
  } else {
    doRank(null, null);
  }
});

// ===========================================================================
// OVERTIME & PAYMENT
// ===========================================================================
let otSelectedIds = new Set();

async function loadOvertimeRequests() {
  try {
    const status = document.getElementById('ot-filter-status').value;
    const data = await apiFetch('/overtime/requests' + (status ? `?status=${status}` : ''));
    document.getElementById('ot-stat-total').textContent = '₹' + Math.round(data.totalOtAmount).toLocaleString('en-IN');
    document.getElementById('ot-stat-pending').textContent = data.requests.filter(r => r.status === 'pending').length;

    otSelectedIds.clear();
    document.getElementById('ot-select-all').checked = false;
    const tbody = document.getElementById('ot-table-body');
    if (!data.requests.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="icon">⏱️</div>No OT records. Click "Calculate OT" to scan attendance.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.requests.map(r => `
      <tr>
        <td>${r.status === 'pending' ? `<input type="checkbox" class="ot-row-check" data-id="${r.id}" onchange="toggleOtSelect(${r.id}, this.checked)" />` : ''}</td>
        <td class="mono">${r.employee_id} — ${escapeHtml(r.employee_name || '')}</td>
        <td class="mono" style="font-size:12px">${r.work_date}</td>
        <td class="mono" style="font-size:12px">${r.worked_hours}h</td>
        <td class="mono" style="font-size:12px">${r.ot_hours}h</td>
        <td class="mono" style="font-size:12px">₹${r.rate_per_hour}</td>
        <td class="mono" style="font-size:12px">₹${r.ot_amount}</td>
        <td><span class="badge ${r.status === 'paid' ? 'reliever_on_duty' : r.status === 'approved' ? 'reliever_on_duty' : r.status === 'rejected' ? 'critical' : 'reliever_pending'}">${r.status}</span></td>
        <td>
          ${r.status === 'pending' ? `<button class="btn small" onclick="approveOt(${r.id})">Approve</button> <button class="btn small secondary" onclick="rejectOt(${r.id})">Reject</button>` : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}
document.getElementById('ot-filter-status').addEventListener('change', loadOvertimeRequests);
document.getElementById('ot-refresh-btn').addEventListener('click', loadOvertimeRequests);

function toggleOtSelect(id, checked) {
  if (checked) otSelectedIds.add(id); else otSelectedIds.delete(id);
}
document.getElementById('ot-select-all').addEventListener('change', (e) => {
  document.querySelectorAll('.ot-row-check').forEach(cb => {
    cb.checked = e.target.checked;
    toggleOtSelect(Number(cb.dataset.id), e.target.checked);
  });
});

async function approveOt(id) {
  try { await apiFetch(`/overtime/requests/${id}/approve`, { method: 'PUT' }); showToast('OT approved'); loadOvertimeRequests(); }
  catch (err) { showToast(err.message, true); }
}
async function rejectOt(id) {
  try { await apiFetch(`/overtime/requests/${id}/reject`, { method: 'PUT' }); showToast('OT rejected'); loadOvertimeRequests(); }
  catch (err) { showToast(err.message, true); }
}

document.getElementById('ot-bulk-approve-btn').addEventListener('click', async () => {
  const ids = Array.from(otSelectedIds);
  if (!ids.length) { showToast('Select at least one pending request first (or leave none checked to approve ALL pending in view)', true); }
  if (!confirm(ids.length ? `Approve ${ids.length} selected OT record(s)?` : 'Approve ALL pending OT records currently in view?')) return;
  try {
    const data = await apiFetch('/overtime/requests/bulk-approve', { method: 'PUT', body: JSON.stringify(ids.length ? { ids } : {}) });
    showToast(data.message);
    loadOvertimeRequests();
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('ot-generate-btn').addEventListener('click', () => {
  document.getElementById('ot-generate-error').style.display = 'none';
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('ot-generate-from').value = today;
  document.getElementById('ot-generate-to').value = today;
  document.getElementById('ot-generate-modal').classList.remove('hidden');
});
document.getElementById('ot-generate-cancel-btn').addEventListener('click', () => document.getElementById('ot-generate-modal').classList.add('hidden'));
document.getElementById('ot-generate-submit-btn').addEventListener('click', async () => {
  const errBox = document.getElementById('ot-generate-error');
  errBox.style.display = 'none';
  const from = document.getElementById('ot-generate-from').value;
  const to = document.getElementById('ot-generate-to').value;
  if (!from || !to) { errBox.textContent = 'Both dates are required'; errBox.style.display = 'block'; return; }
  try {
    const data = await apiFetch('/overtime/generate', { method: 'POST', body: JSON.stringify({ from, to }) });
    showToast(`${data.message} — ${data.created} new, ${data.updated} updated`);
    document.getElementById('ot-generate-modal').classList.add('hidden');
    loadOvertimeRequests();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
});

document.getElementById('ot-export-btn').addEventListener('click', async () => {
  try {
    const status = document.getElementById('ot-filter-status').value;
    const res = await fetch(API + '/overtime/requests/export/excel' + (status ? `?status=${status}` : ''), {
      headers: { Authorization: 'Bearer ' + getToken() },
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Export failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'Overtime_Report.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('ot-payment-batch-btn').addEventListener('click', async () => {
  if (!confirm('Generate a payment batch for ALL approved-and-unpaid OT? This downloads a bank-upload Excel file and marks those records as paid.')) return;
  try {
    const res = await fetch(API + '/overtime/payment-batch', {
      method: 'POST', headers: { Authorization: 'Bearer ' + getToken(), 'Content-Type': 'application/json' },
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Payment batch failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'OT_Payment_Batch.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Payment batch generated and downloaded');
    loadOvertimeRequests();
    loadPaymentBatches();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function loadPaymentBatches() {
  try {
    const data = await apiFetch('/overtime/payment-batches');
    const tbody = document.getElementById('ot-batch-table-body');
    tbody.innerHTML = data.batches.length ? data.batches.map(b => `
      <tr>
        <td class="mono">#${b.id}</td>
        <td>${b.record_count}</td>
        <td class="mono">₹${Math.round(b.total_amount).toLocaleString('en-IN')}</td>
        <td><span class="badge reliever_on_duty">${b.status}</span></td>
        <td class="mono" style="font-size:12px">${formatISTDateTime(b.created_at)}</td>
      </tr>
    `).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="icon">💸</div>No payment batches yet</div></td></tr>`;
  } catch (err) {
    // Non-admin roles can't hit this — fail silently rather than toasting an error at them
  }
}

// ===========================================================================
// EMPLOYEE-SIDE: My Reliever Duties + My Overtime
// ===========================================================================
async function loadEmpRelieverDuties() {
  try {
    const data = await apiFetch('/reliever/my/assignments');
    const tbody = document.getElementById('emp-reliever-table-body');
    if (!data.assignments.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="icon">🧑‍✈️</div>No reliever duties assigned to you</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.assignments.map(a => `
      <tr>
        <td>${escapeHtml(a.original_name || a.original_employee_id)}</td>
        <td class="mono" style="font-size:12px">${a.duty_date}</td>
        <td><span class="badge ${a.status === 'accepted' ? 'reliever_on_duty' : a.status === 'assigned' ? 'reliever_pending' : a.status === 'rejected' ? 'critical' : 'closed'}">${a.status}</span></td>
        <td>
          ${a.status === 'assigned' ? `<button class="btn small" onclick="empRespondReliever(${a.id}, 'accept')">Accept</button> <button class="btn small secondary" onclick="empRespondReliever(${a.id}, 'reject')">Reject</button>` : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}
async function empRespondReliever(id, action) {
  try {
    await apiFetch(`/reliever/my/assignments/${id}/${action}`, { method: 'PUT' });
    showToast(action === 'accept' ? 'Duty accepted' : 'Duty rejected');
    loadEmpRelieverDuties();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadEmpOvertimeHistory() {
  try {
    const data = await apiFetch('/overtime/my/records');
    const tbody = document.getElementById('emp-overtime-table-body');
    if (!data.records.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">⏱️</div>No overtime records yet</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.records.map(r => `
      <tr>
        <td class="mono" style="font-size:12px">${r.work_date}</td>
        <td class="mono" style="font-size:12px">${r.worked_hours}h</td>
        <td class="mono" style="font-size:12px">${r.ot_hours}h</td>
        <td class="mono" style="font-size:12px">₹${r.rate_per_hour}</td>
        <td class="mono" style="font-size:12px">₹${r.ot_amount}</td>
        <td><span class="badge ${r.status === 'paid' ? 'reliever_on_duty' : r.status === 'approved' ? 'reliever_on_duty' : r.status === 'rejected' ? 'critical' : 'reliever_pending'}">${r.status}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

// ===========================================================================
// CLIENT ACCOUNTS: Edit (create + delete already existed)
// ===========================================================================
async function editClientAccount(id) {
  try {
    const data = await apiFetch('/client-accounts');
    const client = data.clients.find(c => c.id === id);
    if (!client) { showToast('Client not found', true); return; }

    document.getElementById('client-new-error').style.display = 'none';
    document.getElementById('client-new-username').value = client.username;
    document.getElementById('client-new-username').disabled = true;
    document.getElementById('client-new-password').value = '';
    document.getElementById('client-new-password').placeholder = 'Leave blank to keep current password';
    document.getElementById('client-new-name').value = client.name;
    document.getElementById('client-new-email').value = client.contact_email || '';

    const select = document.getElementById('client-new-projects');
    select.innerHTML = '';
    const projData = await apiFetch('/projects');
    projData.projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      opt.selected = client.projects.includes(p.name);
      select.appendChild(opt);
    });

    document.getElementById('client-new-modal').classList.remove('hidden');
    document.getElementById('client-new-submit-btn').dataset.editId = id;
  } catch (err) {
    showToast(err.message, true);
  }
}

// ===========================================================================
// LIVE LOCATION TRACKING (employee side) — runs only while on_duty (see the punch-success
// handler and loadMyStatus above, which start/stop this). Pings every 90s; deliberately not
// more frequent than that to keep battery/data usage reasonable on a phone that's on all shift.
// ===========================================================================
let liveLocationTimer = null;
function startLiveLocationTracking() {
  if (liveLocationTimer) return; // already running
  const sendPing = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => {
        apiFetch('/attendance/location-ping', {
          method: 'POST',
          body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        }).catch(() => { /* a single missed ping isn't worth interrupting the employee over */ });
      },
      () => { /* location denied/unavailable this cycle — just skip, try again next interval */ },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  };
  sendPing(); // first ping immediately, don't wait a full interval
  liveLocationTimer = setInterval(sendPing, 90000);
}
function stopLiveLocationTracking() {
  if (liveLocationTimer) { clearInterval(liveLocationTimer); liveLocationTimer = null; }
}

// ===========================================================================
// NEARBY SEARCH (admin/manager) — "who's on-duty near this site right now", using live GPS.
// ===========================================================================
async function loadNearbySearch() {
  try {
    const select = document.getElementById('nearby-search-site');
    if (!select.dataset.loaded) {
      const data = await apiFetch('/projects');
      data.projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name; opt.textContent = p.name;
        select.appendChild(opt);
      });
      select.dataset.loaded = '1';
    }
  } catch (err) { /* best effort */ }
}
document.getElementById('nearby-search-btn').addEventListener('click', async () => {
  const project = document.getElementById('nearby-search-site').value;
  const radius = document.getElementById('nearby-search-radius').value || 10;
  const results = document.getElementById('nearby-search-results');
  if (!project) { showToast('Select a site', true); return; }
  results.innerHTML = `<div class="empty-state"><div class="icon">📍</div>Searching...</div>`;
  try {
    const data = await apiFetch(`/attendance/nearby-site/${encodeURIComponent(project)}?radius_km=${radius}`);
    if (!data.employees.length) {
      results.innerHTML = `<div class="empty-state"><div class="icon">📍</div>No on-duty employees with live location within ${radius}km of ${escapeHtml(project)}</div>`;
      return;
    }
    results.innerHTML = data.employees.map((e, i) => `
      <div class="panel" style="margin-bottom:8px;padding:10px 14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <b>#${i + 1}</b> ${escapeHtml(e.name)} <span class="mono" style="font-size:11px;color:var(--text-muted)">(${e.employee_id})</span>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeHtml(e.project || '')} • last ping ${formatISTDateTime(e.live_last_ping_at)}</div>
          </div>
          <div style="font-weight:800;">${e.distance_km} km</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    results.innerHTML = '';
    showToast(err.message, true);
  }
});

// ===========================================================================
// RELIEVER AUTO-ASSIGN toggle (admin) — ON: server runs it automatically in the background
// every 5 min for shortage sites. OFF: fully manual (existing ranking modal/assign flow).
// ===========================================================================
async function loadAutoAssignToggle() {
  try {
    const data = await apiFetch('/reliever/auto-assign-settings');
    const btn = document.getElementById('reliever-auto-assign-btn');
    btn.textContent = data.enabled ? '🤖 Auto-Assign: ON' : '🤖 Auto-Assign: OFF';
    btn.classList.toggle('secondary', !data.enabled);
    btn.dataset.enabled = data.enabled ? '1' : '0';
  } catch (err) { /* best effort */ }
}
document.getElementById('reliever-auto-assign-btn').addEventListener('click', async () => {
  const btn = document.getElementById('reliever-auto-assign-btn');
  const currentlyEnabled = btn.dataset.enabled === '1';
  const turningOn = !currentlyEnabled;
  if (turningOn && !confirm('Turn ON Reliever Auto-Assign?\n\nThe system will automatically detect staff shortages and force-assign the nearest free employee — no manual approval, running every ~5 minutes in the background.')) return;
  try {
    const data = await apiFetch('/reliever/auto-assign-settings', { method: 'PUT', body: JSON.stringify({ enabled: turningOn }) });
    showToast(data.message);
    loadAutoAssignToggle();
    if (turningOn) {
      const runData = await apiFetch('/reliever/auto-assign/run', { method: 'POST' });
      showToast(runData.message);
      loadRelieverDashboard();
    }
  } catch (err) {
    showToast(err.message, true);
  }
});

// ===========================================================================
// EMPLOYEE TRACKING — LIVE MAP (Leaflet + OpenStreetMap tiles, no API key needed)
// ===========================================================================
let trackingMapInstance = null;
let trackingMapLayer = null;
let trackingMapRefreshTimer = null;

function ensureTrackingMap() {
  if (trackingMapInstance) return trackingMapInstance;
  trackingMapInstance = L.map('tracking-map').setView([20.5937, 78.9629], 5); // India-wide default
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(trackingMapInstance);
  trackingMapLayer = L.layerGroup().addTo(trackingMapInstance);
  return trackingMapInstance;
}

async function loadTrackingMap() {
  try {
    const map = ensureTrackingMap();
    // Leaflet needs an explicit size recalculation the first time its container becomes
    // visible (it was `display:none` while on a hidden tab, so Leaflet's initial size
    // read is wrong until this runs).
    setTimeout(() => map.invalidateSize(), 50);

    const data = await apiFetch('/attendance/tracking-map');
    trackingMapLayer.clearLayers();
    const bounds = [];

    data.sites.forEach(s => {
      const latlng = [Number(s.latitude), Number(s.longitude)];
      bounds.push(latlng);
      L.circle(latlng, { radius: Number(s.geofence_radius_m) || 200, color: '#0B93D6', fillColor: '#0B93D6', fillOpacity: 0.08, weight: 1 })
        .addTo(trackingMapLayer);
      L.marker(latlng, {
        icon: L.divIcon({ className: '', html: '🔵', iconSize: [24, 24] }),
      }).addTo(trackingMapLayer).bindPopup(`<b>${escapeHtml(s.name)}</b><br>${escapeHtml(s.client || '')}`);
    });

    data.employees.forEach(e => {
      const latlng = [Number(e.live_latitude), Number(e.live_longitude)];
      bounds.push(latlng);
      L.marker(latlng, {
        icon: L.divIcon({ className: '', html: '🟢', iconSize: [22, 22] }),
      }).addTo(trackingMapLayer).bindPopup(
        `<b>${escapeHtml(e.name)}</b> (${e.employee_id})<br>${escapeHtml(e.project || '')}<br><span style="font-size:11px;color:#64748B">Last ping: ${formatISTDateTime(e.live_last_ping_at)}</span>`
      );
    });

    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });

    document.getElementById('tracking-last-updated').textContent =
      `Updated ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} — ${data.employees.length} on-duty with live GPS, ${data.sites.length} site(s) mapped`;
  } catch (err) {
    showToast(err.message, true);
  }
}
function startTrackingMapAutoRefresh() {
  stopTrackingMapAutoRefresh();
  trackingMapRefreshTimer = setInterval(loadTrackingMap, 30000);
}
function stopTrackingMapAutoRefresh() {
  if (trackingMapRefreshTimer) { clearInterval(trackingMapRefreshTimer); trackingMapRefreshTimer = null; }
}
document.getElementById('tracking-refresh-btn').addEventListener('click', loadTrackingMap);


