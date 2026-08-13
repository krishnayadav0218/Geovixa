# Geovixa — Changed Files Only (Reliever/OT + Site Map + Phase 2 modules)

Replace/add these files at the SAME path inside your project (paths below are relative to
your project root, e.g. `Geovixa-main/`). No other files were touched.

## 🆕 New files (add these — they don't exist in your current project)
- backend/otCalculator.js
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
- **Reliever Management** — dashboard, force-assign, AI ranking (distance/attendance/shift/OT) with a "🤖 Find Best Reliever" button in the UI, employee-side "My Reliever Duties" accept/reject
- **Overtime & Payment** — full tab: calculate OT from attendance, approve/reject/bulk-approve, Excel export, payment-batch generation (admin), payment batch history, employee-side "My Overtime" history, and shift-category OT rate (₹/hr) editable from Manage Shift Categories
- **Site Management + Live Operations Map** — geofence, required manpower, health score
- **Maintenance & SLA tickets** — open → assigned → in_progress → resolved → verified → closed
- **Employee SOS** — panic button, live admin feed, acknowledge/resolve
- **Announcements** — broadcast to everyone / staff-only / a specific site
- **Emergency Operations** — auto shortage detection + escalation log
- **Client Portal** — separate read-only login for external clients, scoped to their sites, admin can now Edit (not just create/delete) client accounts
- **Audit & Security** — activity log + login history (success/fail) with 24h fail counter
- **Employee bank details** — editable from the Edit Employee modal (needed for OT payment batches)
- **Company feature toggles** — the platform-owner's company create/edit screen now has checkboxes for all 6 new features (previously only the original 4 were listed there)

All of the above were tested end-to-end against a live Postgres database and a real
browser-DOM click-through (jsdom) before being handed off — see the chat for the test
transcripts.
