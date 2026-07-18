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
//   - No punch at all: 'W/O' on Sunday (weekly off, not counted as absence), else 'A'
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
// thresholdsMap: see getThresholds above.
// Returns one of: 'P' | 'HD' | 'A' | 'W/O' | '-'
function computeDayStatus({ onDutyTime, offDutyTime, shiftCategory, isSunday, joined, thresholdsMap }) {
  if (joined === false) return '-'; // before Date of Joining

  if (!onDutyTime) {
    return isSunday ? 'W/O' : 'A';
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

module.exports = { computeDayStatus, getThresholds, shiftCategoryLabel, loadShiftThresholdsMap, DEFAULT_THRESHOLDS };
