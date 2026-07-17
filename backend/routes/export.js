const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../db');
const { verifyAdminOrManager } = require('../middleware');

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

// GET /api/export/excel?from=YYYY-MM-DD&to=YYYY-MM-DD&employee_id=xxx
router.get('/excel', async (req, res) => {
  const { from, to, employee_id, location } = req.query;

  let query = `
    SELECT a.employee_id, e.name, e.designation, a.attendance_date, a.status,
           a.latitude, a.longitude, a.address, a.server_time
    FROM attendance a
    LEFT JOIN employees e ON e.employee_id = a.employee_id
    WHERE 1=1`;
  const params = [];

  if (from) { params.push(from); query += ` AND a.attendance_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND a.attendance_date <= $${params.length}`; }
  if (employee_id) { params.push(employee_id); query += ` AND a.employee_id = $${params.length}`; }
  if (location) { params.push(location); query += ` AND e.location = $${params.length}`; }

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
  workbook.creator = 'Krystal Company';
  const sheet = workbook.addWorksheet('Attendance Report');

  sheet.columns = [
    { header: 'Employee ID', key: 'employee_id', width: 15 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Designation', key: 'designation', width: 18 },
    { header: 'Date', key: 'attendance_date', width: 14 },
    { header: 'On Duty', key: 'on_duty', width: 10 },
    { header: 'Off Duty', key: 'off_duty', width: 10 },
    { header: 'On Duty Time', key: 'on_duty_time', width: 16 },
    { header: 'On Duty Location', key: 'on_duty_location', width: 32 },
    { header: 'Off Duty Time', key: 'off_duty_time', width: 16 },
    { header: 'Off Duty Location', key: 'off_duty_location', width: 32 },
    { header: 'Working Hours', key: 'working_hours', width: 14 },
  ];

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  Array.from(grouped.values()).forEach(g => {
    const row = sheet.addRow({
      employee_id: g.employee_id,
      name: g.name,
      designation: g.designation,
      attendance_date: g.attendance_date,
      on_duty: g.on_duty_time_raw ? '✓' : '',
      off_duty: g.off_duty_time_raw ? '✓' : '',
      on_duty_time: formatISTTime(g.on_duty_time_raw),   // the actual selfie-capture time, IST, time-only
      off_duty_time: formatISTTime(g.off_duty_time_raw), // same — time-only, not the full date
      on_duty_location: g.on_duty_location,
      off_duty_location: g.off_duty_location,
      working_hours: formatWorkingHours(g.on_duty_time_raw, g.off_duty_time_raw),
    });
    if (g.on_duty_time_raw) row.getCell('on_duty').font = { color: { argb: 'FF2E7D32' }, bold: true };
    if (g.off_duty_time_raw) row.getCell('off_duty').font = { color: { argb: 'FFC62828' }, bold: true };
  });

  const filename = `Krystal_Attendance_${from || 'all'}_to_${to || todayDateStr()}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

// GET /api/export/summary-excel?from=YYYY-MM-DD&to=YYYY-MM-DD
// Date-wise P/A matrix report — one row per employee, one column per date.
router.get('/summary-excel', async (req, res) => {
  const to = req.query.to || todayDateStr();
  const from = req.query.from || to;
  const { location } = req.query;

  let empQuery = 'SELECT employee_id, name, designation, location, doj FROM employees WHERE active = 1';
  const empParams = [];
  if (location) { empParams.push(location); empQuery += ` AND location = $${empParams.length}`; }
  empQuery += ' ORDER BY employee_id ASC';

  const empResult = await pool.query(empQuery, empParams);
  const employees = empResult.rows;

  const attResult = await pool.query(
    'SELECT employee_id, attendance_date FROM attendance WHERE attendance_date >= $1 AND attendance_date <= $2',
    [from, to]
  );
  const presentSet = new Set(attResult.rows.map(r => `${r.employee_id}|${r.attendance_date}`));

  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Krystal Company';
  const sheet = workbook.addWorksheet('P-A Report');

  const baseColumns = [
    { header: 'Employee ID', key: 'employee_id', width: 15 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Designation', key: 'designation', width: 18 },
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
      location: emp.location || '',
      doj: emp.doj || '',
    };
    dates.forEach(d => {
      if (emp.doj && d < emp.doj) {
        rowData[d] = '-'; // not joined yet
      } else if (presentSet.has(`${emp.employee_id}|${d}`)) {
        rowData[d] = 'P'; // worked, even if it was a Sunday
      } else if (isSunday(d)) {
        rowData[d] = 'W/O'; // weekly off, not an absence
      } else {
        rowData[d] = 'A';
      }
    });
    const row = sheet.addRow(rowData);

    dates.forEach((d, i) => {
      const cell = row.getCell(baseColumns.length + i + 1);
      if (cell.value === 'P') cell.font = { color: { argb: 'FF2E7D32' }, bold: true };
      if (cell.value === 'A') cell.font = { color: { argb: 'FFC62828' }, bold: true };
      if (cell.value === 'W/O') cell.font = { color: { argb: 'FF1565C0' }, bold: true };
    });
  });

  const filename = `Krystal_PA_Report_${from}_to_${to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

// GET /api/export/employees-excel?location=xxx -> full employee master-data report
router.get('/employees-excel', async (req, res) => {
  const { location } = req.query;

  let query = 'SELECT employee_id, name, designation, phone, location, doj, active, created_at FROM employees';
  const params = [];
  if (location) { params.push(location); query += ` WHERE location = $${params.length}`; }
  query += ' ORDER BY employee_id ASC';

  const { rows } = await pool.query(query, params);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Krystal Company';
  const sheet = workbook.addWorksheet('Employee Data');

  sheet.columns = [
    { header: 'Employee ID', key: 'employee_id', width: 15 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Designation', key: 'designation', width: 18 },
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
      phone: r.phone || '',
      location: r.location || '',
      doj: r.doj || '',
      status: r.active ? 'Active' : 'Inactive',
      created_at: r.created_at,
    });
  });

  const filename = `Krystal_Employee_Data_${todayDateStr()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
