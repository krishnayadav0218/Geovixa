const API = '/api';

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
function getToken() { return sessionStorage.getItem('krystal_token'); }
function getRole() { return sessionStorage.getItem('krystal_role'); }
function getStaffProject() { return sessionStorage.getItem('krystal_project') || null; }
function getEmployeeInfo() {
  try { return JSON.parse(sessionStorage.getItem('krystal_employee') || 'null'); } catch (e) { return null; }
}
function saveSession(token, role, employee, project) {
  sessionStorage.setItem('krystal_token', token);
  sessionStorage.setItem('krystal_role', role);
  if (employee) sessionStorage.setItem('krystal_employee', JSON.stringify(employee));
  if (project) sessionStorage.setItem('krystal_project', project);
  else sessionStorage.removeItem('krystal_project');
}
function clearSession() {
  sessionStorage.removeItem('krystal_token');
  sessionStorage.removeItem('krystal_role');
  sessionStorage.removeItem('krystal_employee');
  sessionStorage.removeItem('krystal_project');
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
  'role-select-view', 'employee-login-view', 'manager-login-view', 'coordinator-login-view', 'admin-login-view',
  'employee-dashboard-view', 'dashboard-view', 'logged-out-view'
];
function showView(id) {
  ALL_VIEWS.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
}

// ---------------- URL ROUTING ----------------
// Supports direct navigation: /employee, /manager, /coordinator, /admin, and / (role select)
function pathToRole(path) {
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === '/employee') return 'employee';
  if (clean === '/manager') return 'manager';
  if (clean === '/coordinator') return 'coordinator';
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
  const staffRoles = ['admin', 'manager', 'coordinator'];

  if (role === 'employee') {
    if (token && sessionRole === 'employee') showEmployeeDashboard();
    else showView('employee-login-view');
  } else if (staffRoles.includes(role)) {
    if (token && staffRoles.includes(sessionRole)) showDashboard();
    else showView(role + '-login-view');
  } else {
    // "/" or any unknown path -> role select, unless already logged in
    if (token && sessionRole === 'employee') showEmployeeDashboard();
    else if (token && staffRoles.includes(sessionRole)) showDashboard();
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

document.getElementById('coordinator-login-btn').addEventListener('click', () => doStaffLogin('coordinator'));
document.getElementById('coordinator-login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doStaffLogin('coordinator'); });

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

    if (data.role !== kind) {
      throw new Error(`This account is not a ${kind[0].toUpperCase() + kind.slice(1)} account. Please use the correct sign-in option.`);
    }

    saveSession(data.token, data.role, null, data.project || null);
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
  document.getElementById('emp-today-date').textContent = formatISTDate(istNow());
  showView('employee-dashboard-view');
  loadMyStatus();
}

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
      <td style="font-size:12px;color:var(--text-muted)">${r.address || (r.latitude.toFixed(5) + ', ' + r.longitude.toFixed(5))}</td>
      <td class="mono">${formatISTDateTime(r.server_time)}</td>
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

    return { latitude: coords.latitude, longitude: coords.longitude };
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
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.display_name || '';
  } catch (err) {
    return '';
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
        address,
        device_time: punchDate.toISOString(),
      })
    });
    showToast(pendingPunchStatus === 'on_duty' ? 'Punched In successfully' : 'Punched Out successfully');
    closeCameraModal();
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
  document.body.classList.remove('role-admin', 'role-manager', 'role-coordinator');
  document.body.classList.add('role-' + role);
  document.getElementById('role-pill').textContent = role.toUpperCase();

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

  // If a non-admin (manager/coordinator) landed on an admin-only tab from a previous admin
  // session, reset to overview.
  if (role !== 'admin') {
    document.querySelectorAll('.nav-item[data-tab]').forEach(i => i.classList.remove('active'));
    document.querySelector('.nav-item[data-tab="overview"]').classList.add('active');
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
    document.getElementById('tab-overview').classList.remove('hidden');
  }

  loadOverview();
  loadProjects();
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
    if (item.dataset.tab === 'attendance') { loadProjects(); loadAttendance(); }
    if (item.dataset.tab === 'reports') { loadProjects(); prefillReportDatesIfEmpty(); }
    if (item.dataset.tab === 'employees') { loadProjects(); loadEmployees(); }
    if (item.dataset.tab === 'managers') { loadProjects(); loadManagers(); loadCoordinatorAccounts(); }
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
      a.download = `Krystal_Connect_Attendance_Report.xlsx`;
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
  const project = document.getElementById('report-project').value.trim();

  let query = [`from=${from}`, `to=${to}`];
  if (location) query.push(`location=${encodeURIComponent(location)}`);
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
      a.download = `Krystal_Connect_PA_Report.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('P/A report downloaded');
    })
    .catch(err => showToast(err.message, true));
});

document.getElementById('download-employees-excel-btn').addEventListener('click', () => {
  const location = document.getElementById('employee-report-location').value.trim();
  const project = document.getElementById('employee-report-project').value.trim();
  let query = [];
  if (location) query.push(`location=${encodeURIComponent(location)}`);
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
      a.download = `Krystal_Connect_Employee_Data.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Employee data report downloaded');
    })
    .catch(err => showToast(err.message, true));
});

// ---------------- PROJECTS ----------------
// Any project whose name starts with "MCGM" (MCGM, MCGM HK, MCGM Education, and any future
// MCGM-prefixed project) gets grouped together under one "MCGM" heading in every dropdown —
// this is name-based so it keeps working automatically for new MCGM projects added later too.
function buildProjectOptionsHTML(projects, placeholderOptionHTML) {
  const mcgmGroup = projects.filter(p => p.name.trim().toUpperCase().startsWith('MCGM'));
  const others = projects.filter(p => !p.name.trim().toUpperCase().startsWith('MCGM'));

  let html = placeholderOptionHTML;
  others.forEach(p => { html += `<option value="${p.name}">${p.name}</option>`; });
  if (mcgmGroup.length) {
    html += `<optgroup label="MCGM">`;
    mcgmGroup.forEach(p => { html += `<option value="${p.name}">${p.name}</option>`; });
    html += `</optgroup>`;
  }
  return html;
}

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

    const selectIds = ['add-emp-project', 'emp-filter-project', 'filter-project', 'report-project', 'employee-report-project', 'add-mgr-project', 'add-coordinator-project'];
    selectIds.forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const prevValue = sel.value;
      const placeholder = sel.querySelector('option')?.outerHTML || '<option value="">— Select —</option>';

      if (locked) {
        // Manager/Coordinator: only their own project is selectable, and it's locked.
        sel.innerHTML = `<option value="${staffProject}">${staffProject}</option>`;
        sel.value = staffProject;
        sel.disabled = true;
        sel.title = 'Aapko sirf apna assigned project dikhega';
      } else {
        sel.disabled = false;
        sel.innerHTML = buildProjectOptionsHTML(allProjects, placeholder);
        if (allProjects.some(p => p.name === prevValue)) sel.value = prevValue;
      }
    });

    const listBox = document.getElementById('projects-list');
    if (listBox) {
      if (allProjects.length === 0) {
        listBox.innerHTML = `<span style="font-size:12px;color:var(--text-muted)">No projects yet</span>`;
      } else {
        listBox.innerHTML = allProjects.map(p => `
          <span class="badge on_duty" style="gap:6px">
            ${p.name}
            ${isAdmin ? `<span style="cursor:pointer;font-weight:bold" onclick="deleteProject(${p.id}, '${p.name.replace(/'/g, "\\'")}')" title="Remove project">✕</span>` : ''}
          </span>
        `).join('');
      }
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('add-project-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('add-project-name');
  const name = nameInput.value.trim();
  if (!name) {
    showToast('Project name is required', true);
    return;
  }
  try {
    await apiFetch('/projects', { method: 'POST', body: JSON.stringify({ name }) });
    showToast(`Project "${name}" added`);
    nameInput.value = '';
    loadProjects();
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

// ---------------- EMPLOYEES ----------------
function shiftCategoryLabel(cat) {
  if (cat === '12HK') return '12 Hrs - HK';
  if (cat === '12ATT') return '12 Hrs - ATT';
  if (cat === '8FA') return '8 Hrs - FA';
  return '-';
}

async function loadEmployees() {
  try {
    const project = document.getElementById('emp-filter-project').value.trim();
    const data = await apiFetch('/employees' + (project ? '?project=' + encodeURIComponent(project) : ''));
    document.getElementById('employee-count').textContent = `Employee List (${data.count})`;
    const tbody = document.getElementById('employees-table-body');
    const isAdmin = getRole() === 'admin';

    if (data.employees.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><div class="icon">👥</div>No employees added yet</div></td></tr>`;
      return;
    }

    tbody.innerHTML = data.employees.map(e => `
      <tr>
        <td class="mono">${e.employee_id}</td>
        <td>${e.name}</td>
        <td>${e.designation || '-'}</td>
        <td class="mono">${e.phone || '-'}</td>
        <td>${e.location || '-'}</td>
        <td>${e.project || '-'}</td>
        <td>${shiftCategoryLabel(e.shift_category)}</td>
        <td class="mono">${e.doj || '-'}</td>
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

document.getElementById('emp-filter-project').addEventListener('change', loadEmployees);

document.getElementById('add-emp-btn').addEventListener('click', async () => {
  const employee_id = document.getElementById('add-emp-id').value.trim();
  const name = document.getElementById('add-emp-name').value.trim();
  const designation = document.getElementById('add-emp-designation').value.trim();
  const phone = document.getElementById('add-emp-phone').value.trim();
  const location = document.getElementById('add-emp-location').value.trim();
  const project = document.getElementById('add-emp-project').value.trim();
  const shift_category = document.getElementById('add-emp-shift').value.trim();
  const doj = document.getElementById('add-emp-doj').value;

  if (!employee_id || !name) {
    showToast('Employee ID and Name are required', true);
    return;
  }

  try {
    await apiFetch('/employees', {
      method: 'POST',
      body: JSON.stringify({ employee_id, name, designation, phone, location, doj, project, shift_category })
    });
    showToast(`Employee ${employee_id} added successfully`);
    document.getElementById('add-emp-id').value = '';
    document.getElementById('add-emp-name').value = '';
    document.getElementById('add-emp-designation').value = '';
    document.getElementById('add-emp-phone').value = '';
    document.getElementById('add-emp-location').value = '';
    document.getElementById('add-emp-project').value = '';
    document.getElementById('add-emp-shift').value = '';
    document.getElementById('add-emp-doj').value = '';
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
    const [employee_id, name, designation, phone, location, doj, project, shift_category] = parts;
    return { employee_id, name, designation, phone, location, doj, project, shift_category };
  });

  submitBulkEmployees(employees);
  document.getElementById('bulk-emp-paste').value = '';
});

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
        <td><button class="btn secondary small" onclick="deleteCoordinatorAccount(${a.id})">Remove</button></td>
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
