// Turns a day's on_duty/off_duty punches into an OT (overtime) figure.
//
// Rule: OT hours = hours actually worked beyond the employee's shift_category's "full_hours"
// threshold (the same full_hours used by attendanceStatus.js to mark a day 'P'). A half-day
// or absent day never generates OT. This intentionally mirrors computeDayStatus() so OT and
// the P/HD/A report can never disagree about how many hours someone worked on a given day.
//
// rate_per_hour comes from shift_categories.ot_rate_per_hour for that employee's shift
// category (admin-configured, see routes/shiftCategories.js) — 0 if never configured, in
// which case ot_hours still gets recorded (for visibility) but ot_amount is 0 until the
// admin sets a rate and the record is recalculated.

const { getThresholds, DEFAULT_THRESHOLDS } = require('./attendanceStatus');

// onDutyTime / offDutyTime: JS Date-parsable values (or null if that punch didn't happen).
// shiftCategory: employee's shift_category string.
// thresholdsMap: { [shift_category_name]: { full, half } } — see loadShiftThresholdsMap.
// Returns { workedHours, otHours } — both 0 if the day isn't a complete in+out pair.
function computeOtHours({ onDutyTime, offDutyTime, shiftCategory, thresholdsMap }) {
  if (!onDutyTime || !offDutyTime) return { workedHours: 0, otHours: 0 };

  const workedHours = (new Date(offDutyTime) - new Date(onDutyTime)) / (1000 * 60 * 60);
  if (workedHours <= 0) return { workedHours: 0, otHours: 0 };

  const { full } = getThresholds(shiftCategory, thresholdsMap) || DEFAULT_THRESHOLDS;
  const otHours = workedHours > full ? Math.round((workedHours - full) * 100) / 100 : 0;
  return { workedHours: Math.round(workedHours * 100) / 100, otHours };
}

// Loads { [shift_category_name]: ot_rate_per_hour } for a company — mirrors
// loadShiftThresholdsMap in attendanceStatus.js but for the OT rate column.
async function loadOtRateMap(pool, companyId) {
  const { rows } = await pool.query(
    'SELECT name, ot_rate_per_hour FROM shift_categories WHERE company_id = $1',
    [companyId]
  );
  const map = {};
  rows.forEach((r) => { map[r.name] = Number(r.ot_rate_per_hour) || 0; });
  return map;
}

module.exports = { computeOtHours, loadOtRateMap };
