const API = '/api';

// ---------------- STORAGE HELPERS ----------------
// Using sessionStorage (NOT localStorage) so that closing the browser tab/window
// automatically clears the session -> user is logged out and must sign in again.
function getToken() { return sessionStorage.getItem('mtdc_token'); }
function getRole() { return sessionStorage.getItem('mtdc_role'); }
function getEmployeeInfo() {
  try { return JSON.parse(sessionStorage.getItem('mtdc_employee') || 'null'); } catch (e) { return null; }
}
function saveSession(token, role, employee) {
  sessionStorage.setItem('mtdc_token', token);
  sessionStorage.setItem('mtdc_role', role);
  if (employee) sessionStorage.setItem('mtdc_employee', JSON.stringify(employee));
}
function clearSession() {
  sessionStorage.removeItem('mtdc_token');
  sessionStorage.removeItem('mtdc_role');
  sessionStorage.removeItem('mtdc_employee');
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
  'role-select-view', 'employee-login-view', 'manager-login-view', 'admin-login-view',
  'employee-dashboard-view', 'dashboard-view'
];
function showView(id) {
  ALL_VIEWS.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
}

// ---------------- URL ROUTING ----------------
// Supports direct navigation: /employee, /manager, /admin, and / (role select)
function pathToRole(path) {
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === '/employee') return 'employee';
  if (clean === '/manager') return 'manager';
  if (clean === '/admin') return 'admin';
  return null;
}

function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  renderRoute();
}

function renderRoute() {
  const role = pathToRole(window.location.pathname);
  const token = getToken();
  const sessionRole = getRole();

  if (role === 'employee') {
    if (token && sessionRole === 'employee') showEmployeeDashboard();
    else showView('employee-login-view');
  } else if (role === 'manager' || role === 'admin') {
    if (token && (sessionRole === 'admin' || sessionRole === 'manager')) showDashboard();
    else showView(role + '-login-view');
  } else {
    // "/" or any unknown path -> role select, unless already logged in
    if (token && sessionRole === 'employee') showEmployeeDashboard();
    else if (token && (sessionRole === 'admin' || sessionRole === 'manager')) showDashboard();
    else showView('role-select-view');
  }
}

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
  clearSession();
  navigate('/');
}

// ===========================================================================
// EMPLOYEE LOGIN
// ===========================================================================
document.getElementById('employee-login-btn').addEventListener('click', doEmployeeLogin);
document.getElementById('employee-login-id').addEventListener('keydown', e => { if (e.key === 'Enter') doEmployeeLogin(); });

async function doEmployeeLogin() {
  const employee_id = document.getElementById('employee-login-id').value.trim();
  const errBox = document.getElementById('employee-login-error');
  errBox.style.display = 'none';

  if (!employee_id) {
    errBox.textContent = 'Please enter your Employee ID';
    errBox.style.display = 'block';
    return;
  }

  try {
    const res = await fetch(API + '/auth/employee-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    saveSession(data.token, 'employee', data.employee);
    document.getElementById('employee-login-id').value = '';
    navigate('/employee', true);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  }
}

// ===========================================================================
// MANAGER / ADMIN LOGIN (shared handler, different form ids)
// ===========================================================================
document.getElementById('manager-login-btn').addEventListener('click', () => doStaffLogin('manager'));
document.getElementById('manager-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doStaffLogin('manager'); });

document.getElementById('admin-login-btn').addEventListener('click', () => doStaffLogin('admin'));
document.getElementById('admin-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doStaffLogin('admin'); });

async function doStaffLogin(kind) {
  const username = document.getElementById(`${kind}-login-username`).value.trim();
  const password = document.getElementById(`${kind}-login-password`).value;
  const errBox = document.getElementById(`${kind}-login-error`);
  errBox.style.display = 'none';

  if (!username || !password) {
    errBox.textContent = 'Please enter username and password';
    errBox.style.display = 'block';
    return;
  }

  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    if (kind === 'manager' && data.role !== 'manager') {
      throw new Error('This account is not a Manager account. Use Admin login instead.');
    }
    if (kind === 'admin' && data.role !== 'admin') {
      throw new Error('This account is not an Admin account. Use Manager login instead.');
    }

    saveSession(data.token, data.role, null);
    document.getElementById(`${kind}-login-password`).value = '';
    navigate('/' + data.role, true);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
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
  document.getElementById('emp-today-date').textContent = new Date().toDateString();
  showView('employee-dashboard-view');
  loadMyStatus();
}

async function loadMyStatus() {
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

    renderTodayAttendance(data.records);
  } catch (err) {
    showToast(err.message, true);
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
      <td style="font-size:12px;color:var(--text-muted)">${r.address || (r.latitude.toFixed(5) + ', ' + r.longitude.toFixed(5))}</td>
      <td class="mono">${new Date(r.server_time).toLocaleString('en-IN')}</td>
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

  // Start camera
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    document.getElementById('camera-video').srcObject = cameraStream;
  } catch (err) {
    document.getElementById('camera-status').textContent = 'Camera access denied. Please allow camera permission.';
    return;
  }

  // Get geolocation in parallel
  if (!navigator.geolocation) {
    document.getElementById('camera-status').textContent = 'Geolocation not supported on this device/browser.';
    return;
  }
  document.getElementById('camera-status').textContent = 'Verifying live location…';
  try {
    capturedLocation = await getVerifiedLocation();
    document.getElementById('camera-status').textContent = 'Location captured. Ready to take selfie.';
    document.getElementById('camera-capture-btn').disabled = false;
  } catch (err) {
    document.getElementById('camera-status').textContent = err.message;
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
  return new Promise((resolve, reject) => {
    const readOnce = () => new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => res(pos.coords),
        (err) => rej(new Error('Location access denied. Please allow location permission.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });

    (async () => {
      try {
        const first = await readOnce();
        if (!first.accuracy) {
          return reject(new Error('Location looks artificial (no GPS accuracy reported). Please disable mock location / location simulation and try again.'));
        }
        await new Promise(r => setTimeout(r, 1500));
        const second = await readOnce();

        const identical =
          first.latitude === second.latitude &&
          first.longitude === second.longitude &&
          first.accuracy === second.accuracy;

        if (identical) {
          return reject(new Error('Fake/mock location detected. Please disable mock location (Developer options) or any GPS spoofing app and try again with real GPS.'));
        }

        resolve({ latitude: second.latitude, longitude: second.longitude });
      } catch (err) {
        reject(err);
      }
    })();
  });
}

function closeCameraModal() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  document.getElementById('camera-modal').classList.add('hidden');
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.display_name || '';
  } catch (err) {
    return '';
  }
}

async function captureAndSubmit() {
  if (!capturedLocation) {
    showToast('Location not available yet', true);
    return;
  }
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  canvas.width = video.videoWidth || 480;
  canvas.height = video.videoHeight || 360;
  const ctx = canvas.getContext('2d');
  // Mirror to match the preview (selfie view)
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  capturedPhoto = canvas.toDataURL('image/jpeg', 0.8);

  document.getElementById('camera-capture-btn').disabled = true;
  document.getElementById('camera-status').textContent = 'Submitting attendance…';

  const address = await reverseGeocode(capturedLocation.latitude, capturedLocation.longitude);

  try {
    await apiFetch('/attendance/punch', {
      method: 'POST',
      body: JSON.stringify({
        status: pendingPunchStatus,
        photo: capturedPhoto,
        latitude: capturedLocation.latitude,
        longitude: capturedLocation.longitude,
        address,
        device_time: new Date().toISOString(),
      })
    });
    showToast(pendingPunchStatus === 'on_duty' ? 'Punched In successfully' : 'Punched Out successfully');
    closeCameraModal();
    loadMyStatus();
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
  document.body.classList.remove('role-admin', 'role-manager');
  document.body.classList.add('role-' + role);
  document.getElementById('role-pill').textContent = role.toUpperCase();

  showView('dashboard-view');
  document.getElementById('today-date').textContent = new Date().toDateString();

  // If manager landed on an admin-only tab from a previous admin session, reset to overview
  if (role === 'manager') {
    document.querySelectorAll('.nav-item[data-tab]').forEach(i => i.classList.remove('active'));
    document.querySelector('.nav-item[data-tab="overview"]').classList.add('active');
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
    document.getElementById('tab-overview').classList.remove('hidden');
  }

  loadOverview();
}

// ---------------- TABS ----------------
document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
  item.addEventListener('click', () => {
    if (item.classList.contains('admin-only') && getRole() !== 'admin') return;
    document.querySelectorAll('.nav-item[data-tab]').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
    document.getElementById('tab-' + item.dataset.tab).classList.remove('hidden');

    if (item.dataset.tab === 'overview') loadOverview();
    if (item.dataset.tab === 'attendance') loadAttendance();
    if (item.dataset.tab === 'employees') loadEmployees();
    if (item.dataset.tab === 'managers') loadManagers();
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
          <td class="mono">${s.time ? new Date(s.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
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

  let query = [];
  if (from) query.push(`from=${from}`);
  if (to) query.push(`to=${to}`);
  if (emp) query.push(`employee_id=${encodeURIComponent(emp)}`);

  try {
    const data = await apiFetch('/attendance' + (query.length ? '?' + query.join('&') : ''));
    document.getElementById('records-count').textContent = `Records (${data.count})`;
    const tbody = document.getElementById('attendance-table-body');

    if (data.records.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon">📭</div>No attendance records found</div></td></tr>`;
      return;
    }

    tbody.innerHTML = data.records.map(r => `
      <tr>
        <td>${photoThumb(r.photo)}</td>
        <td class="mono">${r.attendance_date}</td>
        <td class="mono">${r.employee_id}</td>
        <td>${r.employee_name || '-'}</td>
        <td><span class="badge ${r.status}"><span class="badge-dot"></span>${r.status.replace('_', ' ')}</span></td>
        <td class="mono">${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}</td>
        <td class="mono">${new Date(r.server_time).toLocaleString('en-IN')}</td>
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
  loadAttendance();
});

document.getElementById('download-excel-btn').addEventListener('click', () => {
  const from = document.getElementById('filter-from').value;
  const to = document.getElementById('filter-to').value;
  const emp = document.getElementById('filter-emp').value.trim();

  let query = [];
  if (from) query.push(`from=${from}`);
  if (to) query.push(`to=${to}`);
  if (emp) query.push(`employee_id=${encodeURIComponent(emp)}`);

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
      a.download = `MTDC_Attendance_Report.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Excel report downloaded');
    })
    .catch(err => showToast(err.message, true));
});

// ---------------- EMPLOYEES ----------------
async function loadEmployees() {
  try {
    const data = await apiFetch('/employees');
    document.getElementById('employee-count').textContent = `Employee List (${data.count})`;
    const tbody = document.getElementById('employees-table-body');
    const isAdmin = getRole() === 'admin';

    if (data.employees.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">👥</div>No employees added yet</div></td></tr>`;
      return;
    }

    tbody.innerHTML = data.employees.map(e => `
      <tr>
        <td class="mono">${e.employee_id}</td>
        <td>${e.name}</td>
        <td>${e.designation || '-'}</td>
        <td class="mono">${e.phone || '-'}</td>
        <td>
          <span class="badge ${e.active ? 'on_duty' : 'off_duty'}">
            <span class="badge-dot"></span>${e.active ? 'Active' : 'Inactive'}
          </span>
        </td>
        <td class="admin-only-cell">
          ${isAdmin ? `<button class="btn secondary small" onclick="toggleEmployee('${e.employee_id}', ${e.active ? 0 : 1})">
            ${e.active ? 'Deactivate' : 'Activate'}
          </button>` : ''}
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
  const designation = document.getElementById('add-emp-designation').value.trim();
  const phone = document.getElementById('add-emp-phone').value.trim();

  if (!employee_id || !name) {
    showToast('Employee ID and Name are required', true);
    return;
  }

  try {
    await apiFetch('/employees', {
      method: 'POST',
      body: JSON.stringify({ employee_id, name, designation, phone })
    });
    showToast(`Employee ${employee_id} added successfully`);
    document.getElementById('add-emp-id').value = '';
    document.getElementById('add-emp-name').value = '';
    document.getElementById('add-emp-designation').value = '';
    document.getElementById('add-emp-phone').value = '';
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

// ---------------- MANAGERS (admin only) ----------------
async function loadManagers() {
  if (getRole() !== 'admin') return;
  try {
    const data = await apiFetch('/auth/managers');
    document.getElementById('manager-count').textContent = `Manager List (${data.count})`;
    const tbody = document.getElementById('managers-table-body');
    if (data.managers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><div class="icon">🗂️</div>No manager accounts yet</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.managers.map(m => `
      <tr>
        <td class="mono">${m.username}</td>
        <td class="mono">${new Date(m.created_at).toLocaleDateString('en-IN')}</td>
        <td><button class="btn secondary small" onclick="deleteManager(${m.id})">Remove</button></td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('add-mgr-btn').addEventListener('click', async () => {
  const username = document.getElementById('add-mgr-username').value.trim();
  const password = document.getElementById('add-mgr-password').value;
  if (!username || !password || password.length < 6) {
    showToast('Username and password (min 6 characters) are required', true);
    return;
  }
  try {
    await apiFetch('/auth/managers', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    showToast(`Manager ${username} added successfully`);
    document.getElementById('add-mgr-username').value = '';
    document.getElementById('add-mgr-password').value = '';
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
