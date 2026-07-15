const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const db = require('../db');
const { verifyAdminOrManager } = require('../middleware');

router.use(verifyAdminOrManager);

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// Format any timestamp (device_time or server_time) as IST clock time only, e.g. "09:41:07 AM"
// device_time is the employee's phone clock at the moment of punch (sent from the browser/app),
// so this reflects the employee's live phone time rather than the server's.
function formatTimeIST(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

// GET /api/export/excel?from=YYYY-MM-DD&to=YYYY-MM-DD&employee_id=xxx
router.get('/excel', async (req, res) => {
  const { from, to, employee_id } = req.query;

  let query = `
    SELECT a.employee_id, e.name, e.designation, a.attendance_date, a.status,
           a.latitude, a.longitude, a.address, a.server_time, a.device_time
    FROM attendance a
    LEFT JOIN employees e ON e.employee_id = a.employee_id
    WHERE 1=1`;
  const params = [];

  if (from) { query += ' AND a.attendance_date >= ?'; params.push(from); }
  if (to) { query += ' AND a.attendance_date <= ?'; params.push(to); }
  if (employee_id) { query += ' AND a.employee_id = ?'; params.push(employee_id); }

  query += ' ORDER BY a.attendance_date DESC, a.employee_id ASC, a.server_time ASC';

  const allRows = db.prepare(query).all(...params);

  // Keep only the FIRST punch-in (on_duty) and the LAST punch-out (off_duty)
  // for each employee, on each day — ignore any extra punches in between.
  const groups = {};
  allRows.forEach(r => {
    const key = r.employee_id + '_' + r.attendance_date;
    if (!groups[key]) groups[key] = { firstIn: null, lastOut: null };
    const ts = new Date(r.device_time || r.server_time).getTime();

    if (r.status === 'on_duty') {
      const curTs = groups[key].firstIn ? new Date(groups[key].firstIn.device_time || groups[key].firstIn.server_time).getTime() : null;
      if (curTs === null || ts < curTs) groups[key].firstIn = r;
    } else if (r.status === 'off_duty') {
      const curTs = groups[key].lastOut ? new Date(groups[key].lastOut.device_time || groups[key].lastOut.server_time).getTime() : null;
      if (curTs === null || ts > curTs) groups[key].lastOut = r;
    }
  });

  const rows = [];
  Object.values(groups).forEach(g => {
    if (g.firstIn) rows.push(g.firstIn);
    if (g.lastOut) rows.push(g.lastOut);
  });
  rows.sort((a, b) => {
    if (a.attendance_date !== b.attendance_date) return a.attendance_date < b.attendance_date ? 1 : -1;
    if (a.employee_id !== b.employee_id) return a.employee_id < b.employee_id ? -1 : 1;
    return new Date(a.device_time || a.server_time) - new Date(b.device_time || b.server_time);
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MTDC - Krystal Company';
  const sheet = workbook.addWorksheet('Attendance Report');

  sheet.columns = [
    { header: 'Employee ID', key: 'employee_id', width: 15 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Designation', key: 'designation', width: 18 },
    { header: 'Date', key: 'attendance_date', width: 14 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Latitude', key: 'latitude', width: 14 },
    { header: 'Longitude', key: 'longitude', width: 14 },
    { header: 'Address', key: 'address', width: 35 },
    { header: 'Time', key: 'time_only', width: 16 },
  ];

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  rows.forEach(r => {
    sheet.addRow({
      employee_id: r.employee_id,
      name: r.name || '',
      designation: r.designation || '',
      attendance_date: r.attendance_date,
      status: r.status.replace('_', ' '),
      latitude: r.latitude,
      longitude: r.longitude,
      address: r.address || '',
      time_only: formatTimeIST(r.device_time || r.server_time),
    });
  });

  const filename = `MTDC_Attendance_${from || 'all'}_to_${to || todayDateStr()}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
