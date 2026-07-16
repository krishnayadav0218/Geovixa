const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const db = require('../db');
const { verifyAdminOrManager } = require('../middleware');

router.use(verifyAdminOrManager);

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/export/excel?from=YYYY-MM-DD&to=YYYY-MM-DD&employee_id=xxx
router.get('/excel', async (req, res) => {
  const { from, to, employee_id } = req.query;

  let query = `
    SELECT a.employee_id, e.name, e.designation, a.attendance_date, a.status,
           a.latitude, a.longitude, a.address, a.server_time
    FROM attendance a
    LEFT JOIN employees e ON e.employee_id = a.employee_id
    WHERE 1=1`;
  const params = [];

  if (from) { query += ' AND a.attendance_date >= ?'; params.push(from); }
  if (to) { query += ' AND a.attendance_date <= ?'; params.push(to); }
  if (employee_id) { query += ' AND a.employee_id = ?'; params.push(employee_id); }

  query += ' ORDER BY a.attendance_date DESC, a.employee_id ASC, a.server_time ASC';

  const rows = db.prepare(query).all(...params);

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
    { header: 'Recorded At (Server Time)', key: 'server_time', width: 22 },
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
      server_time: r.server_time,
    });
  });

  const filename = `MTDC_Attendance_${from || 'all'}_to_${to || todayDateStr()}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

// GET /api/export/summary-excel?from=YYYY-MM-DD&to=YYYY-MM-DD
// Date-wise Present/Absent matrix report (Reports tab) — one row per employee,
// one column per date, "P" if any punch that day, "A" if none, "-" if before their DOJ.
router.get('/summary-excel', async (req, res) => {
  const to = req.query.to || todayDateStr();
  const from = req.query.from || to;

  const employees = db.prepare(
    'SELECT employee_id, name, designation, location, doj FROM employees WHERE active = 1 ORDER BY employee_id ASC'
  ).all();

  const rows = db.prepare(
    'SELECT employee_id, attendance_date FROM attendance WHERE attendance_date >= ? AND attendance_date <= ?'
  ).all(from, to);
  const presentSet = new Set(rows.map(r => `${r.employee_id}|${r.attendance_date}`));

  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MTDC - Krystal Company';
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
      rowData[d] = (emp.doj && d < emp.doj) ? '-' : (presentSet.has(`${emp.employee_id}|${d}`) ? 'P' : 'A');
    });
    const row = sheet.addRow(rowData);

    // Colour P green, A red for quick scanning
    dates.forEach((d, i) => {
      const cell = row.getCell(baseColumns.length + i + 1);
      if (cell.value === 'P') cell.font = { color: { argb: 'FF2E7D32' }, bold: true };
      if (cell.value === 'A') cell.font = { color: { argb: 'FFC62828' }, bold: true };
    });
  });

  const filename = `MTDC_PA_Report_${from}_to_${to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
