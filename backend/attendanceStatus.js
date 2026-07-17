// Shared logic for turning a day's punches into a P / HD / A / W-O / - status.
// Used by both routes/attendance.js (grid endpoint, shown in the app) and
// routes/export.js (Excel reports) so both stay perfectly in sync.
//
// Rules (as decided with the client):
//   - Employee.shift_category tells us which duty-hours slab the employee is on:
//       '12HK'  -> 12 hour shift (Housekeeping)   -> full day = 12h, half day = 6h
//       '12ATT' -> 12 hour shift (Attendant)       -> full day = 12h, half day = 6h
//       '8FA'   -> 8 hour shift  (Field/Fire Attendant, etc.) -> full day = 8h, half day = 4h
//       anything else / blank -> defaults to the 8h/4h slab
//   - Punched IN but never punched OUT that day -> 'A' (Absent), regardless of shift.
//   - Punched IN and OUT, worked >= full-day hours -> 'P' (Present, full day)
//   - Punched IN and OUT, worked >= half-day hours but < full-day hours -> 'HD' (Half Day)
//   - Punched IN and OUT, worked < half-day hours -> 'A' (didn't even complete a half day)
//   - No punch at all: 'W/O' on Sunday (weekly off, not counted as absence), else 'A'
//   - Before the employee's Date of Joining -> '-' (not applicable)

const SHIFT_THRESHOLDS = {
  '12HK': { full: 12, half: 6 },
  '12ATT': { full: 12, half: 6 },
  '8FA': { full: 8, half: 4 },
};
const DEFAULT_THRESHOLDS = { full: 8, half: 4 };

const SHIFT_CATEGORY_LABELS = {
  '12HK': '12 Hrs - HK',
  '12ATT': '12 Hrs - ATT',
  '8FA': '8 Hrs - FA',
};

function getThresholds(shiftCategory) {
  return SHIFT_THRESHOLDS[shiftCategory] || DEFAULT_THRESHOLDS;
}

function shiftCategoryLabel(shiftCategory) {
  return SHIFT_CATEGORY_LABELS[shiftCategory] || (shiftCategory || '-');
}

// onDutyTime / offDutyTime: JS Date (or date-parsable value) of that day's on_duty / off_duty
// punch (server_time), or null/undefined if that punch didn't happen.
// Returns one of: 'P' | 'HD' | 'A' | 'W/O' | '-'
function computeDayStatus({ onDutyTime, offDutyTime, shiftCategory, isSunday, joined }) {
  if (joined === false) return '-'; // before Date of Joining

  if (!onDutyTime) {
    return isSunday ? 'W/O' : 'A';
  }
  if (!offDutyTime) {
    return 'A'; // punched in but never punched out
  }

  const hours = (new Date(offDutyTime) - new Date(onDutyTime)) / (1000 * 60 * 60);
  const { full, half } = getThresholds(shiftCategory);

  if (hours >= full) return 'P';
  if (hours >= half) return 'HD';
  return 'A';
}

module.exports = { computeDayStatus, getThresholds, shiftCategoryLabel, SHIFT_THRESHOLDS, DEFAULT_THRESHOLDS };
