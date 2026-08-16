# Geovixa — Changed Files Only

Apply these at the SAME path inside your project (paths relative to your project root, e.g.
`Geovixa-main/`). Nothing else in your project was touched.

## 🆕 New files (add — don't exist in your current project)
- `backend/otCalculator.js`
- `backend/autoAssignEngine.js`
- `backend/mlRankerBridge.js`
- `backend/ml/rank_relievers.py`
- `backend/ml/predict_shortage.py` ← **new this round**
- `backend/routes/reliever.js`
- `backend/routes/overtime.js`
- `backend/routes/audit.js`
- `backend/routes/announcements.js`
- `backend/routes/maintenance.js`
- `backend/routes/sos.js`
- `backend/routes/emergency.js`
- `backend/routes/clientAccounts.js`
- `backend/routes/clientPortal.js`
- `backend/routes/siteLocations.js`
- `backend/routes/performance.js` ← **new this round**
- `backend/routes/predictive.js` ← **new this round**
- `backend/routes/aiAssistant.js` ← **new this round**

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
1. `cd backend && npm install`
2. Optional (AI reliever ranking + predictive forecasting): `pip3 install --break-system-packages scikit-learn numpy` — both features are pure enhancements and fall back to plain-JS formulas automatically if Python/scikit-learn isn't present.
3. Restart the server — `db.js` runs all migrations automatically and safely.

---

## 🆕 This round: the 5 previously-missing features, all built for real

### 1. AI Assistant (natural language query)
Rule-based intent matching against known question patterns (not a general-purpose LLM — none
is embedded in this app), querying the real database for the answer. Handles: absent count
today, critical/short-staffed sites, open SOS alerts, this month's overtime, reliever status,
open maintenance tickets. Unrecognized questions get an honest "here's what I can help with"
fallback instead of a wrong guess. New "🤖 AI Assistant" tab with a chat interface.

### 2. Predictive Workforce Intelligence
Genuinely **predictive** (forecasts tomorrow, before it happens) as distinct from the
already-built shortage detection (which only reports shortage that already happened today).
`ml/predict_shortage.py` looks at each site's own attendance history on the SAME weekday as
tomorrow, blends the raw and recency-weighted shortfall rate, and outputs a probability +
honest confidence level (a site with almost no history says so, rather than presenting a
guess as a real estimate). Falls back to an equivalent plain-JS calculation if Python isn't
available. New "🔮 Predictive Workforce" tab.

### 3. Employee Performance Score
0-100 composite: attendance % (50pts) + on-time full-day rate (30pts) + conduct (20pts, -10
per SOS alert raised in the window). New "🏆 Performance" tab, sortable by score, with
Excellent/Good/Average/Needs Improvement categories.

### 4. Fake GPS + Device Binding
- **Impossible-travel detection**: if a punch implies traveling faster than 200 km/h since
  the employee's last known position (their last punch OR last live-tracking ping, whichever
  is more recent) within the last 6 hours, it's rejected outright — genuinely reliable, since
  teleporting between two points minutes apart is never real GPS. Verified: a punch from
  1154km away, 5 minutes after a real nearby position, was correctly blocked with a specific
  distance/time explanation.
- **Device binding**: an employee's first punch binds their device fingerprint
  (client-generated, not hardware). Later punches from a different device are FLAGGED (audit
  log + `attendance.device_mismatch`) but not blocked outright, since phones legitimately get
  replaced — an admin can clear the binding (`PUT /employees/:id/reset-device`) when that
  happens.

### 5. Offline Attendance + Auto-Sync
If a punch fails due to a genuine network failure (not a server-side rejection like geofence
or device issues — those still show their real error and are never queued), it's saved to an
on-device queue (localStorage) instead of lost, with a "⏳ N pending sync" badge on the
employee dashboard. Automatically resubmitted the moment the browser's `online` event fires,
plus a 30s backup retry timer in case that event is missed. A queued item's timestamp is
preserved (`captured_at`) and marked `synced_late` so admins can tell "punched now" from
"punched earlier, synced late" in the data.

All five verified end-to-end against a live PostgreSQL database and/or real browser-DOM
click-through (jsdom) — see the chat for full test transcripts, including the impossible-
travel block, device-mismatch flagging, offline queue/badge behavior, and live chat-style
AI Assistant answers.

---

## Full feature list (all rounds)

- **Reliever Management** — dashboard, force-assign, AI ranking (real spatial nearest-neighbor
  search + a trained scoring model, Python/scikit-learn with automatic JS-formula fallback),
  employee-side accept/reject
- **Reliever Auto-Assign** — per-company ON/OFF toggle; background loop (every 5 min) detects
  shortages at BOTH whole-project and individual-sub-location level and auto-assigns the
  nearest free employees to each independently
- **Site Locations** — multiple GPS+radius+required-headcount sub-locations within one project
  (e.g. 400 employees / 100 buildings), each tracked for shortage separately from the project total
- **Geofenced attendance** — punch in/out rejected outside the assigned radius (location-level
  if assigned, else project-level)
- **Live GPS tracking** — pings every ~90s while on_duty; **Employee Tracking** live map
  (Leaflet/OpenStreetMap) and **Nearby Search** both use it
- **Overtime & Payment**, **Site Management + Live Operations Map**, **Maintenance & SLA
  tickets**, **Employee SOS**, **Announcements**, **Emergency Operations** (with escalation
  history), **Client Portal** (read-only, scoped), **Audit & Security**
- **AI Assistant**, **Predictive Workforce Intelligence**, **Employee Performance Score**,
  **Fake GPS/device-binding detection**, **Offline attendance sync** (this round)
- **Service URL setup screen** — for a future Capacitor-wrapped mobile app; zero effect on
  the normal web app

Every feature listed has been tested end-to-end against a live PostgreSQL database and a
real browser-DOM click-through (jsdom simulating actual clicks/logins/form submissions).
