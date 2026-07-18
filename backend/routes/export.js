const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { verifyAdminOrManager } = require('../middleware');
const { computeDayStatus, shiftCategoryLabel } = require('../attendanceStatus');
const { effectiveProject } = require('../projectScope');

router.use(verifyAdminOrManager);

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// A date string (YYYY-MM-DD) falls on a Sunday? Checked in UTC since these are plain
// calendar-date strings (no time component), not real timestamps — so this is timezone-safe.
function isSunday(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay() === 0;
}

// Formats a punch's server_time (the moment the selfie was actually captured) as a plain
// IST clock time — e.g. "04:22 PM" — instead of writing the raw Date object into the Excel
// cell, which was the bug: ExcelJS/Excel would then display it using a date-only number
// format (e.g. "17-07-2026"), silently dropping the time entirely.
function formatISTTime(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date(date));
}

// "8h 15m" style duration between on-duty and off-duty punch timestamps.
function formatWorkingHours(onDuty, offDuty) {
  if (!onDuty || !offDuty) return '';
  const ms = new Date(offDuty) - new Date(onDuty);
  if (ms <= 0) return '';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// GET /api/export/excel?from=YYYY-MM-DD&to=YYYY-MM-DD&employee_id=xxx&project=xxx
router.get('/excel', async (req, res) => {
  const { from, to, employee_id, location } = req.query;
  const project = effectiveProject(req);

  let query = `
    SELECT a.employee_id, e.name, e.designation, e.project, e.shift_category, e.doj,
           a.attendance_date, a.status, a.latitude, a.longitude, a.address, a.server_time
    FROM attendance a
    LEFT JOIN employees e ON e.employee_id = a.employee_id
    WHERE 1=1`;
  const params = [];

  if (from) { params.push(from); query += ` AND a.attendance_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND a.attendance_date <= $${params.length}`; }
  if (employee_id) { params.push(employee_id); query += ` AND a.employee_id = $${params.length}`; }
  if (location) { params.push(location); query += ` AND e.location = $${params.length}`; }
  if (project) { params.push(project); query += ` AND e.project = $${params.length}`; }

  query += ' ORDER BY a.attendance_date DESC, a.employee_id ASC, a.server_time ASC';

  const { rows } = await pool.query(query, params);

  // group the on_duty + off_duty punches for the same employee+date into a single row,
  // like an actual timesheet, instead of one row per punch
  const grouped = new Map();
  rows.forEach(r => {
    const key = `${r.employee_id}|${r.attendance_date}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        employee_id: r.employee_id,
        name: r.name || '',
        designation: r.designation || '',
        project: r.project || '',
        shift_category: r.shift_category || '',
        attendance_date: r.attendance_date,
        on_duty_time_raw: null,
        off_duty_time_raw: null,
        on_duty_location: '',
        off_duty_location: '',
      });
    }
    const g = grouped.get(key);
    const loc = r.address || (r.latitude !== null && r.longitude !== null ? `${r.latitude}, ${r.longitude}` : '');
    if (r.status === 'on_duty') {
      g.on_duty_time_raw = r.server_time;
      g.on_duty_location = loc;
    } else if (r.status === 'off_duty') {
      g.off_duty_time_raw = r.server_time;
      g.off_duty_location = loc;
    }
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Krystal Connect';
  const sheet = workbook.addWorksheet('Attendance Report');

  sheet.columns = [
    { header: 'Employee ID', key: 'employee_id', width: 15 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Designation', key: 'designation', width: 18 },
    { header: 'Project', key: 'project', width: 16 },
    { header: 'Shift Category', key: 'shift_category', width: 14 },
    { header: 'Date', key: 'attendance_date', width: 14 },
    { header: 'On Duty', key: 'on_duty', width: 10 },
    { header: 'Off Duty', key: 'off_duty', width: 10 },
    { header: 'On Duty Time', key: 'on_duty_time', width: 16 },
    { header: 'On Duty Location', key: 'on_duty_location', width: 32 },
    { header: 'Off Duty Time', key: 'off_duty_time', width: 16 },
    { header: 'Off Duty Location', key: 'off_duty_location', width: 32 },
    { header: 'Working Hours', key: 'working_hours', width: 14 },
    { header: 'Day Status', key: 'day_status', width: 12 },
  ];

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  Array.from(grouped.values()).forEach(g => {
    const dayStatus = computeDayStatus({
      onDutyTime: g.on_duty_time_raw,
      offDutyTime: g.off_duty_time_raw,
      shiftCategory: g.shift_category,
      isSunday: isSunday(g.attendance_date),
      joined: true, // this row only exists because a punch happened, so DOJ isn't relevant here
    });
    const row = sheet.addRow({
      employee_id: g.employee_id,
      name: g.name,
      designation: g.designation,
      project: g.project,
      shift_category: shiftCategoryLabel(g.shift_category),
      attendance_date: g.attendance_date,
      on_duty: g.on_duty_time_raw ? '✓' : '',
      off_duty: g.off_duty_time_raw ? '✓' : '',
      on_duty_time: formatISTTime(g.on_duty_time_raw),   // the actual selfie-capture time, IST, time-only
      off_duty_time: formatISTTime(g.off_duty_time_raw), // same — time-only, not the full date
      on_duty_location: g.on_duty_location,
      off_duty_location: g.off_duty_location,
      working_hours: formatWorkingHours(g.on_duty_time_raw, g.off_duty_time_raw),
      day_status: dayStatus,
    });
    if (g.on_duty_time_raw) row.getCell('on_duty').font = { color: { argb: 'FF2E7D32' }, bold: true };
    if (g.off_duty_time_raw) row.getCell('off_duty').font = { color: { argb: 'FFC62828' }, bold: true };
    const statusCell = row.getCell('day_status');
    if (dayStatus === 'P') statusCell.font = { color: { argb: 'FF2E7D32' }, bold: true };
    if (dayStatus === 'HD') statusCell.font = { color: { argb: 'FFEF6C00' }, bold: true };
    if (dayStatus === 'A') statusCell.font = { color: { argb: 'FFC62828' }, bold: true };
  });

  const filename = `Krystal_Connect_Attendance_${from || 'all'}_to_${to || todayDateStr()}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

// GET /api/export/summary-excel?from=YYYY-MM-DD&to=YYYY-MM-DD&project=xxx
// Date-wise P/HD/A matrix report — one row per employee, one column per date.
router.get('/summary-excel', async (req, res) => {
  const to = req.query.to || todayDateStr();
  const from = req.query.from || to;
  const { location } = req.query;
  const project = effectiveProject(req);

  let empQuery = 'SELECT employee_id, name, designation, location, doj, project, shift_category FROM employees WHERE active = 1';
  const empParams = [];
  if (location) { empParams.push(location); empQuery += ` AND location = $${empParams.length}`; }
  if (project) { empParams.push(project); empQuery += ` AND project = $${empParams.length}`; }
  empQuery += ' ORDER BY employee_id ASC';

  const empResult = await pool.query(empQuery, empParams);
  const employees = empResult.rows;

  const attResult = await pool.query(
    'SELECT employee_id, attendance_date, status, server_time FROM attendance WHERE attendance_date >= $1 AND attendance_date <= $2',
    [from, to]
  );

  // Group punches by employee+date so we know both the on_duty and off_duty time for that day.
  const punchMap = new Map();
  attResult.rows.forEach(r => {
    const key = `${r.employee_id}|${r.attendance_date}`;
    if (!punchMap.has(key)) punchMap.set(key, { onDutyTime: null, offDutyTime: null });
    const entry = punchMap.get(key);
    if (r.status === 'on_duty') entry.onDutyTime = r.server_time;
    else if (r.status === 'off_duty') entry.offDutyTime = r.server_time;
  });

  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Krystal Connect';
  const sheet = workbook.addWorksheet('P-HD-A Report');

  const baseColumns = [
    { header: 'Employee ID', key: 'employee_id', width: 15 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Designation', key: 'designation', width: 18 },
    { header: 'Project', key: 'project', width: 16 },
    { header: 'Shift Category', key: 'shift_category', width: 14 },
    { header: 'Location', key: 'location', width: 20 },
    { header: 'Date of Joining', key: 'doj', width: 16 },
  ];
  const dateColumns = dates.map(d => ({ header: d, key: d, width: 12 }));
  sheet.columns = [...baseColumns, ...dateColumns];

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  employees.forEach(emp => {
    const rowData = {
      employee_id: emp.employee_id,
      name: emp.name,
      designation: emp.designation || '',
      project: emp.project || '',
      shift_category: shiftCategoryLabel(emp.shift_category),
      location: emp.location || '',
      doj: emp.doj || '',
    };
    dates.forEach(d => {
      const joined = !(emp.doj && d < emp.doj);
      const punch = punchMap.get(`${emp.employee_id}|${d}`) || { onDutyTime: null, offDutyTime: null };
      rowData[d] = computeDayStatus({
        onDutyTime: punch.onDutyTime,
        offDutyTime: punch.offDutyTime,
        shiftCategory: emp.shift_category,
        isSunday: isSunday(d),
        joined,
      });
    });
    const row = sheet.addRow(rowData);

    dates.forEach((d, i) => {
      const cell = row.getCell(baseColumns.length + i + 1);
      if (cell.value === 'P') cell.font = { color: { argb: 'FF2E7D32' }, bold: true };
      if (cell.value === 'HD') cell.font = { color: { argb: 'FFEF6C00' }, bold: true };
      if (cell.value === 'A') cell.font = { color: { argb: 'FFC62828' }, bold: true };
      if (cell.value === 'W/O') cell.font = { color: { argb: 'FF1565C0' }, bold: true };
    });
  });

  const filename = `Krystal_Connect_PA_Report_${from}_to_${to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

// GET /api/export/employees-excel?location=xxx&project=xxx -> full employee master-data report
router.get('/employees-excel', async (req, res) => {
  const { location } = req.query;
  const project = effectiveProject(req);

  let query = 'SELECT employee_id, name, designation, phone, location, doj, project, shift_category, active, created_at FROM employees WHERE 1=1';
  const params = [];
  if (location) { params.push(location); query += ` AND location = $${params.length}`; }
  if (project) { params.push(project); query += ` AND project = $${params.length}`; }
  query += ' ORDER BY employee_id ASC';

  const { rows } = await pool.query(query, params);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Krystal Connect';
  const sheet = workbook.addWorksheet('Employee Data');

  sheet.columns = [
    { header: 'Employee ID', key: 'employee_id', width: 15 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Designation', key: 'designation', width: 18 },
    { header: 'Project', key: 'project', width: 16 },
    { header: 'Shift Category', key: 'shift_category', width: 14 },
    { header: 'Phone', key: 'phone', width: 15 },
    { header: 'Location', key: 'location', width: 20 },
    { header: 'Date of Joining', key: 'doj', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Added On', key: 'created_at', width: 20 },
  ];

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  rows.forEach(r => {
    sheet.addRow({
      employee_id: r.employee_id,
      name: r.name,
      designation: r.designation || '',
      project: r.project || '',
      shift_category: shiftCategoryLabel(r.shift_category),
      phone: r.phone || '',
      location: r.location || '',
      doj: r.doj || '',
      status: r.active ? 'Active' : 'Inactive',
      created_at: r.created_at,
    });
  });

  const filename = `Krystal_Connect_Employee_Data_${todayDateStr()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
