# Geovixa — Changed Files Only (Reliever/OT + Site Map + Phase 2 modules)

Replace/add these files at the SAME path inside your project (paths below are relative to
your project root, e.g. `Geovixa-main/`). No other files were touched.

## 🆕 New files (add these — they don't exist in your current project)
- backend/otCalculator.js
- backend/autoAssignEngine.js
- backend/routes/reliever.js
- backend/routes/overtime.js
- backend/routes/audit.js
- backend/routes/announcements.js
- backend/routes/maintenance.js
- backend/routes/sos.js
- backend/routes/emergency.js
- backend/routes/clientAccounts.js
- backend/routes/clientPortal.js

## ✏️ Modified files (overwrite your existing copies with these)
- backend/db.js
- backend/server.js
- backend/middleware.js
- backend/auditLog.js
- backend/companySettings.js
- backend/routes/auth.js
- backend/routes/employees.js
- backend/routes/projects.js
- backend/routes/attendance.js
- backend/routes/shiftCategories.js
- backend/public/index.html
- backend/public/js/app.js
- backend/public/css/style.css

## After replacing the files
1. `cd backend && npm install` (no new npm packages were added — `exceljs` was already a
   dependency — but running it is harmless and safe).
2. Restart the server. `db.js` runs its migrations automatically on boot (`CREATE TABLE IF
   NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` everywhere) — nothing manual needed, and it's
   safe to run against your existing production data.
3. Everything is backward compatible — no existing table/column was removed or renamed.

## What's new (feature summary)
- **Geofence enforcement on punch-in/out** — if a site has a GPS location + radius saved (Site Management), an employee can only punch in/out from within that radius. Sites without a saved location have no geofence to enforce (opt-in per site).
- **Employee Tracking — live map** — new sidebar tab with an actual interactive map (Leaflet + OpenStreetMap, no API key needed): 🔵 site markers with geofence circles, 🟢 on-duty employees at their live position, auto-refreshes every 30s.
- **Service URL setup screen** — only appears when this app is wrapped as a standalone mobile app (Capacitor/Cordova) with no backend configured yet; lets that install point itself at your company's server URL. Has zero effect on the normal web app — completely gated behind detecting a non-http(s) context.
- **Live GPS Tracking** — an employee's app pings their location every ~90s for as long as they're on_duty (stops automatically at punch-out), so "who's near site X right now" is always real-time, not based on the punch-in point.
- **Nearby Search** — panel in Reliever Management: pick a site, get every on-duty employee within a radius, sorted by live distance.
- **AI Reliever Ranking — fixed** — now automatically uses the shortage SITE's own saved GPS (not whoever's browser is open), and ranks candidates by their LIVE position instead of a stale attendance-punch location.
- **Reliever Auto-Assign** — a per-company ON/OFF toggle (admin only). ON: the server itself, in the background (every 5 min, no dashboard needs to be open), detects shortage sites and force-assigns the nearest ~5 free employees automatically. OFF: fully manual, same as before.
- **Reliever Management** — dashboard, force-assign, AI ranking with a "🤖 Find Best Reliever" button in the UI, employee-side "My Reliever Duties" accept/reject
- **Overtime & Payment** — full tab: calculate OT from attendance, approve/reject/bulk-approve, Excel export, payment-batch generation (admin), payment batch history, employee-side "My Overtime" history, and shift-category OT rate (₹/hr) editable from Manage Shift Categories
- **Site Management + Live Operations Map** — geofence, required manpower, health score
- **Maintenance & SLA tickets** — open → assigned → in_progress → resolved → verified → closed
- **Employee SOS** — panic button, live admin feed, acknowledge/resolve
- **Announcements** — broadcast to everyone / staff-only / a specific site
- **Emergency Operations** — auto shortage detection + escalation log
- **Client Portal** — separate read-only login for external clients, scoped to their sites, admin can Edit (not just create/delete) client accounts
- **Audit & Security** — activity log + login history (success/fail) with 24h fail counter
- **Employee bank details** — editable from the Edit Employee modal (needed for OT payment batches)
- **Company feature toggles** — the platform-owner's company create/edit screen now has checkboxes for all 6 new features

All of the above were tested end-to-end against a live Postgres database and a real
browser-DOM click-through (jsdom) before being handed off — see the chat for the test
transcripts.

## 📱 About an APK
A real compiled/signed Android .apk cannot be built in the environment this was developed
in (no access to Android SDK/Google's Maven repo). Two paths forward:
1. **Works today**: open the app in Chrome on Android → menu → "Add to Home Screen" — installs
   like a native app icon.
2. **Real .apk**: wrap this same web app with Capacitor (`@capacitor/core` + `@capacitor/android`,
   both on npm). The new "Setup Service URL" screen in this update exists specifically to support
   that path — a Capacitor build has no same-origin backend to call, so it needs to be told the
   server URL once, which it then remembers. Ask for the ready-to-build Capacitor project
   scaffold and instructions separately; building the final .apk itself requires Android Studio
   on your own machine.
