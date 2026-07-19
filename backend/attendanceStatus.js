// Shared logic for turning a day's punches into a P / HD / A / W-O / - status.
// Used by both routes/attendance.js (grid endpoint, shown in the app) and
// routes/export.js (Excel reports) so both stay perfectly in sync.
//
// Rules (as decided with the client):
//   - Employee.shift_category is a free-text name that matches a row in the admin-managed
//     `shift_categories` table (see routes/shiftCategories.js) — e.g. "12 Hrs - HK" (full=12,
//     half=6), "8 Hrs - FA" (full=8, half=4), "9 Hrs - General" (full=9, half=4.5). Admins can
//     add/remove categories at any time from the Employees tab, same as Projects — nothing
//     here is hardcoded to a specific category, so a newly added one works immediately.
//   - Punched IN but never punched OUT that day -> 'A' (Absent), regardless of shift.
//   - Punched IN and OUT, worked >= full-day hours -> 'P' (Present, full day)
//   - Punched IN and OUT, worked >= half-day hours but < full-day hours -> 'HD' (Half Day)
//   - Punched IN and OUT, worked < half-day hours -> 'A' (didn't even complete a half day)
//   - No punch at all: 'W/O' on the employee's project's configured weekly-off day (defaults
//     to Sunday, but each project can set a different day — not counted as an absence), else 'A'
//   - Before the employee's Date of Joining -> '-' (not applicable)

const DEFAULT_THRESHOLDS = { full: 8, half: 4 };

// thresholdsMap: { [shift_category_name]: { full, half } } — built by the caller from a
// fresh query against the shift_categories table (see attendance.js / export.js). Falls back
// to the 8h/4h default if the employee's shift_category doesn't match any known category
// (e.g. it was left blank, or its category was since removed by the admin).
function getThresholds(shiftCategory, thresholdsMap) {
  if (thresholdsMap && shiftCategory && thresholdsMap[shiftCategory]) {
    return thresholdsMap[shiftCategory];
  }
  return DEFAULT_THRESHOLDS;
}

function shiftCategoryLabel(shiftCategory) {
  return shiftCategory && shiftCategory.trim() ? shiftCategory : '-';
}

// onDutyTime / offDutyTime: JS Date (or date-parsable value) of that day's on_duty / off_duty
// punch (server_time), or null/undefined if that punch didn't happen.
// isWeeklyOff: true if this date falls on the EMPLOYEE'S PROJECT's configured weekly-off day
// (see projects.weekly_off_day) — not hardcoded to Sunday, since not every project's
// workforce is off on a Sunday.
// thresholdsMap: see getThresholds above.
// Returns one of: 'P' | 'HD' | 'A' | 'W/O' | '-'
function computeDayStatus({ onDutyTime, offDutyTime, shiftCategory, isWeeklyOff, joined, thresholdsMap }) {
  if (joined === false) return '-'; // before Date of Joining

  if (!onDutyTime) {
    return isWeeklyOff ? 'W/O' : 'A';
  }
  if (!offDutyTime) {
    return 'A'; // punched in but never punched out
  }

  const hours = (new Date(offDutyTime) - new Date(onDutyTime)) / (1000 * 60 * 60);
  const { full, half } = getThresholds(shiftCategory, thresholdsMap);

  if (hours >= full) return 'P';
  if (hours >= half) return 'HD';
  return 'A';
}

// Loads the shift_categories table into a plain lookup object: { name: { full, half } }.
// Call once per request and reuse it for every employee/date in that request.
async function loadShiftThresholdsMap(pool) {
  const { rows } = await pool.query('SELECT name, full_hours, half_hours FROM shift_categories');
  const map = {};
  rows.forEach(r => {
    map[r.name] = { full: Number(r.full_hours), half: Number(r.half_hours) };
  });
  return map;
}

// Loads the projects table into a plain lookup object: { projectName: weekly_off_day (0-6) }.
// Call once per request. Each project can have a different weekly-off day (not every
// workforce is off on a Sunday) — see the weekly_off_day column on the projects table.
async function loadWeeklyOffMap(pool) {
  const { rows } = await pool.query('SELECT name, weekly_off_day FROM projects');
  const map = {};
  rows.forEach(r => {
    map[r.name] = Number(r.weekly_off_day);
  });
  return map;
}

// ---------------------------------------------------------------------------------------
// 8-HOUR FA SHIFT-CYCLE CLASSIFIER — used only by the new "Shift Cycle Report" (Reports tab
// -> export.js /shift-cycle-excel). An "8 Hrs - FA" employee normally rotates through 3
// back-to-back 8-hour shifts a day apart across a roster, identified purely by the CLOCK
// TIME of their on-duty (login) punch, in IST:
//   Morning   -> logs in 07:00–08:00, logs out ~15:00–16:00
//   Afternoon -> logs in 15:00–16:00, logs out ~23:00–24:00 (midnight)
//   Night     -> logs in 23:00–24:00, logs out ~07:00–08:00 the NEXT morning
// Classification is driven by the LOGIN time only (the logout windows above are informational
// / for reference — a login time is enough to place a punch in one of the 3 buckets). A
// ±30 minute buffer is added around each stated window since real-world punches are rarely
// exact to the minute — e.g. "7 to 8" becomes 06:30–08:30. If a login falls outside all 3
// windows, the session is classified as 'Other' so it's still visible in the report rather
// than silently dropped.
const SHIFT_WINDOWS = [
  { label: 'Morning', startMin: 6 * 60 + 30, endMin: 8 * 60 + 30 },     // 06:30–08:30
  { label: 'Afternoon', startMin: 14 * 60 + 30, endMin: 16 * 60 + 30 }, // 14:30–16:30
  { label: 'Night', startMin: 22 * 60 + 30, endMin: 24 * 60 + 30 },     // 22:30–24:30 (wraps past midnight)
];

// Minutes-since-midnight of a Date, in IST — used instead of raw getHours()/getMinutes()
// since the server itself may not be running in IST.
function istMinutesOfDay(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find(p => p.type === 'hour').value) % 24;
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

// Returns 'Morning' | 'Afternoon' | 'Night' | 'Other' for a punch's on-duty timestamp.
function classifyShiftByLoginTime(onDutyTime) {
  if (!onDutyTime) return 'Other';
  const mins = istMinutesOfDay(new Date(onDutyTime));
  for (const w of SHIFT_WINDOWS) {
    if (mins >= w.startMin && mins <= w.endMin) return w.label;
    // Night window wraps past midnight (22:30 -> 24:30, i.e. 00:30 the next day) — also
    // check the wrapped value (mins + 24h) so a login just after midnight still matches.
    if (mins + 24 * 60 >= w.startMin && mins + 24 * 60 <= w.endMin) return w.label;
  }
  return 'Other';
}

module.exports = {
  computeDayStatus, getThresholds, shiftCategoryLabel, loadShiftThresholdsMap, loadWeeklyOffMap,
  DEFAULT_THRESHOLDS, classifyShiftByLoginTime, istMinutesOfDay,
};
