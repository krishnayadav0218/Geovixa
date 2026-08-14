# Geovixa — Changed Files Only

Apply these at the SAME path inside your project (paths below are relative to your project
root, e.g. `Geovixa-main/`). Nothing else in your project was touched.

## 🆕 New files (add — don't exist in your current project)
- `backend/otCalculator.js`
- `backend/autoAssignEngine.js`
- `backend/mlRankerBridge.js`
- `backend/ml/rank_relievers.py`
- `backend/routes/reliever.js`
- `backend/routes/overtime.js`
- `backend/routes/audit.js`
- `backend/routes/announcements.js`
- `backend/routes/maintenance.js`
- `backend/routes/sos.js`
- `backend/routes/emergency.js`
- `backend/routes/clientAccounts.js`
- `backend/routes/clientPortal.js`
- `backend/routes/siteLocations.js` ← **new this round**

## ✏️ Modified files (overwrite your existing copies)
- `backend/db.js`
- `backend/server.js`
- `backend/middleware.js`
- `backend/auditLog.js`
- `backend/companySettings.js`
- `backend/routes/auth.js`
- `backend/routes/employees.js`
- `backend/routes/projects.js`
- `backend/routes/attendance.js`
- `backend/routes/shiftCategories.js`
- `backend/public/index.html`
- `backend/public/js/app.js`
- `backend/public/css/style.css`

## After applying
1. `cd backend && npm install` (no new npm packages this round — everything used was already a dependency)
2. Optional, for AI reliever ranking: `pip3 install --break-system-packages scikit-learn numpy` (pure enhancement — the app works fine without it, just falls back to a formula-based ranking)
3. Restart the server — `db.js` runs all migrations automatically and safely (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` everywhere), including against an existing production database.

---

## 🆕 This round: Site Locations (multiple locations under one project)

For a project spread across many physical spots — e.g. one project, 400 employees, 100
separate buildings with ~4 employees each — each building can now have its **own** GPS +
punch-in radius, instead of the whole project sharing a single geofence.

### How to set it up

1. **Operations Map** tab → click the project's card → **"📍 Manage Locations"**
2. Add locations two ways:
   - **One at a time**: name + latitude + longitude + radius (meters), click **+ Add**
   - **Bulk** (for all 100 at once): paste into the text box, one per line:
     ```
     Building A, 19.0701, 72.8701, 100
     Building B, 19.0715, 72.8720, 150
     ```
     (radius is optional — defaults to 200m if left off)
3. **Assign employees to a location** — two ways:
   - **One at a time**: Employees → open an employee → **"Site Location"** dropdown (shows
     every location under that employee's project, with a live headcount) → pick one, saves
     instantly
   - **Bulk** (for all 400 at once): add a `site_location` column to your employee import
     sheet with the exact location name — resolved automatically against that row's project

### How the geofence check works now

- Employee has a Site Location assigned → punch-in/out must be within **that location's**
  radius (error message names the specific location, e.g. *"You are 320m away from Building
  A..."*)
- Employee has no Site Location assigned → falls back to the **project's own** single
  geofence, exactly like before this feature existed
- Neither has GPS saved → no geofence enforced at all (unchanged prior behavior)

Verified end-to-end: bulk-created 3 locations, assigned an employee to one, confirmed a
punch at the project's own coordinates was correctly REJECTED (employee is bound to their
specific location, not the project average), and a punch at the assigned location's actual
coordinates succeeded. Bulk employee import with an unresolvable `site_location` name is
rejected per-row with a clear, actionable error rather than silently ignored.

---

## Full feature list (all rounds)

- **Reliever Management** — dashboard, force-assign, AI ranking (real spatial nearest-neighbor
  search + a trained scoring model — Python/scikit-learn with automatic JS-formula fallback if
  unavailable) with a "🤖 Find Best Reliever" button, employee-side accept/reject
- **Reliever Auto-Assign** — per-company ON/OFF toggle; when ON, a background loop (every 5
  min, no dashboard needs to stay open) detects shortage sites and auto-assigns the nearest
  free employees
- **Site Locations** — multiple GPS+radius sub-locations within one project (this round)
- **Geofenced attendance** — punch in/out rejected outside the assigned radius
- **Live GPS tracking** — pings every ~90s while on_duty; **Employee Tracking** live map
  (Leaflet/OpenStreetMap) and **Nearby Search** both use it
- **Overtime & Payment** — auto-calc from attendance, approval workflow, Excel export,
  bank-payment batch generation, employee-side OT history
- **Site Management + Live Operations Map** — health score, manpower, SLA, Emergency
  Escalations panel
- **Maintenance & SLA tickets**, **Employee SOS**, **Announcements**, **Client Portal**
  (read-only, scoped), **Audit & Security** (activity + login history)
- **Service URL setup screen** — for a future Capacitor-wrapped mobile app; has zero effect
  on the normal web app

Every feature listed has been tested end-to-end against a live PostgreSQL database and a
real browser-DOM click-through (jsdom simulating actual clicks/logins/form submissions).
