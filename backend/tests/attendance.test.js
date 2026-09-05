const { makeMockPool } = require('./helpers/mockPool');

// Site: a project geofence centered here with a 200m radius.
const SITE_LAT = 19.0760;
const SITE_LNG = 72.8777;

// ~2km away — well outside any reasonable geofence radius.
const FAR_LAT = 19.0950;
const FAR_LNG = 72.8777;

const BASE_EMPLOYEE = {
  employee_id: 'EMP001',
  active: 1,
  project: 'MCGM HK',
  site_location_id: null,
};

function buildPool({ employee = BASE_EMPLOYEE, projectGeofence, todaysRecords = [], prevLiveLocation = null } = {}) {
  return makeMockPool([
    // gpsAnomalyDetection's "previous known position" lookup — checked before the generic
    // employees lookup below since both queries touch the `employees` table.
    [/SELECT live_latitude, live_longitude, live_last_ping_at FROM employees/i, () => ({ rows: prevLiveLocation ? [prevLiveLocation] : [] })],
    [/SELECT \* FROM employees WHERE employee_id = \$1 AND company_id = \$2/i, () => ({ rows: employee ? [employee] : [] })],
    [/FROM projects WHERE company_id = \$1 AND name = \$2/i, () => ({ rows: projectGeofence ? [projectGeofence] : [] })],
    [/FROM site_locations WHERE id = \$1/i, () => ({ rows: [] })],
    [/INSERT INTO gps_anomaly_flags/i, () => ({ rows: [] })],
    [/SELECT status FROM attendance WHERE employee_id/i, () => ({ rows: todaysRecords })],
    [/INSERT INTO attendance/i, () => ({ rows: [] })],
    [/UPDATE employees SET live_latitude/i, () => ({ rows: [] })],
  ]);
}

function loadRunPunch(pool) {
  jest.resetModules();
  jest.doMock('../db', () => ({ pool }));
  jest.doMock('../photoStorage', () => ({ savePhotoAndGetUrl: jest.fn(() => '/uploads/photos/fake.jpg') }));
  return require('../routes/attendance').__runPunchForTests;
}

const basePunch = {
  employeeId: 'EMP001',
  status: 'on_duty',
  photo: 'data:image/jpeg;base64,ZmFrZQ==',
  accuracy: 12,
  companyId: 1,
};

describe('POST /attendance/punch — runPunch', () => {
  test('succeeds when inside the geofence with a plausible GPS point', async () => {
    const pool = buildPool({
      projectGeofence: { latitude: SITE_LAT, longitude: SITE_LNG, geofence_radius_m: 200 },
    });
    const runPunch = loadRunPunch(pool);

    const result = await runPunch({ ...basePunch, latitude: SITE_LAT, longitude: SITE_LNG });

    expect(result.httpStatus).toBe(200);
    expect(result.body.message).toMatch(/on duty recorded successfully/i);
  });

  test('rejects a punch outside the assigned site geofence', async () => {
    const pool = buildPool({
      projectGeofence: { latitude: SITE_LAT, longitude: SITE_LNG, geofence_radius_m: 200 },
    });
    const runPunch = loadRunPunch(pool);

    const result = await runPunch({ ...basePunch, latitude: FAR_LAT, longitude: FAR_LNG });

    expect(result.httpStatus).toBe(403);
    expect(result.body.error).toMatch(/away from/i);
    expect(result.body.error).toMatch(/must be within 200m/i);
  });

  test('rejects a GPS point that implies impossible travel speed since the last ping', async () => {
    // No geofence configured for this test, so it isolates the anomaly-detection path.
    const pool = buildPool({
      projectGeofence: null,
      // Last known position was ~2km away 10 seconds ago -> ~720 km/h implied speed,
      // well over the 200 km/h IMPOSSIBLE_SPEED_KMH threshold in gpsAnomalyDetection.js.
      prevLiveLocation: {
        live_latitude: SITE_LAT,
        live_longitude: SITE_LNG,
        live_last_ping_at: new Date(Date.now() - 10 * 1000).toISOString(),
      },
    });
    const runPunch = loadRunPunch(pool);

    const result = await runPunch({ ...basePunch, latitude: FAR_LAT, longitude: FAR_LNG });

    expect(result.httpStatus).toBe(409);
    expect(result.body.error).toMatch(/flagged as impossible/i);
  });

  test('rejects a second punch-in on the same day (duplicate punch guard)', async () => {
    const pool = buildPool({
      projectGeofence: null,
      todaysRecords: [{ status: 'on_duty' }],
    });
    const runPunch = loadRunPunch(pool);

    const result = await runPunch({ ...basePunch, latitude: SITE_LAT, longitude: SITE_LNG });

    expect(result.httpStatus).toBe(409);
    expect(result.body.error).toMatch(/already Punched In today/i);
  });

  test('rejects a punch with no GPS accuracy reported (mock-location guard)', async () => {
    const pool = buildPool({ projectGeofence: null });
    const runPunch = loadRunPunch(pool);

    const result = await runPunch({ ...basePunch, accuracy: undefined, latitude: SITE_LAT, longitude: SITE_LNG });

    expect(result.httpStatus).toBe(400);
    expect(result.body.error).toMatch(/mock location/i);
  });

  test('rejects when the employee is deactivated', async () => {
    const pool = buildPool({ employee: { ...BASE_EMPLOYEE, active: 0 }, projectGeofence: null });
    const runPunch = loadRunPunch(pool);

    const result = await runPunch({ ...basePunch, latitude: SITE_LAT, longitude: SITE_LNG });

    expect(result.httpStatus).toBe(403);
    expect(result.body.error).toMatch(/deactivated/i);
  });
});
