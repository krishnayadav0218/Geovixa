# Geovixa — Native Android App (Kotlin + Jetpack Compose)

Yeh project purane Capacitor/WebView-based build ki jagah **poori tarah native Android app**
hai. Neeche har fixed point ka file-reference diya hai + jo backend-side chhote additions
chahiye unka bhi.

## ✅ Kya fix hua (with file references)

| Point | Kahan implement hua |
|---|---|
| Native Android project (Kotlin/Gradle) | Poora project — `app/build.gradle.kts`, `settings.gradle.kts` |
| In-app notification system (read/unread) | `data/local/NotificationEntity.kt`, `NotificationDao.kt`, `ui/screens/NotificationsScreen.kt` + FCM se auto-populate: `notifications/GeovixaFcmService.kt` |
| Real device binding / secure login | `data/local/SecureStorage.kt` (Keystore-backed HMAC key) + `biometric/BiometricHelper.kt` |
| Native GPS / Geofence / Camera | `location/LocationHelper.kt`, `location/GeofenceHelper.kt` + `GeofenceBroadcastReceiver.kt`, `camera/CameraXCapture.kt` |
| Background location (native service) | `location/BackgroundLocationService.kt` — real foreground `Service`, replaces the never-implemented `Capacitor.Plugins.BackgroundTracker` reference |
| Battery optimization handling | `battery/BatteryOptimizationHelper.kt`, wired into `ui/screens/ProfileScreen.kt` **and** a first-run guided onboarding: `ui/screens/PermissionOnboardingScreen.kt` |
| Live battery % on admin's tracking map | `BatteryOptimizationHelper.getBatteryPercent()` → sent with every location ping (`BackgroundLocationService.kt`) → stored in `employees.live_battery_percent` (backend) → shown as 🔋/🪫 on the Employee Tracking map, with a red "LOW — may lose tracking soon" warning under 15% |
| Live Map UI screen | `ui/screens/LiveMapScreen.kt` (OSMdroid — no Google Maps API key needed) |
| Theme persistence | `data/local/ThemePreferences.kt` (DataStore) + `ui/theme/Theme.kt` |
| Offline attendance queue | `data/local/OfflinePunchEntity.kt`, `OfflinePunchDao.kt`, `workers/OfflineSyncWorker.kt` |

Attendance/Leave/Salary/Overtime/Reliever/Concerns/SOS screens sab existing backend routes
(`backend/routes/*.js`) se seedhe jude hain — koi backend logic change nahi karna pada
in sabke liye.

## 🛠 Setup steps (Android Studio required — is sandbox mein compile nahi ho sakta)

1. **Open this folder in Android Studio** (Hedgehog/2023.1+ recommended). It'll prompt to
   generate the missing `gradlew`/`gradle-wrapper.jar` automatically — this sandbox has
   no internet access to `services.gradle.org` so those binary files aren't included.
2. Set your real backend URL in `app/build.gradle.kts`:
   ```kotlin
   buildConfigField("String", "API_BASE_URL", "\"https://YOUR-BACKEND-HOST/api/\"")
   ```
3. **Firebase (for push notifications):**
   - Create a Firebase project → add an Android app with package `com.geovixa.app`
   - Download `google-services.json` → place it at `app/google-services.json`
   - Without this file, the app **will fail to build** — remove the
     `id("com.google.gms.google-services")` plugin line in `app/build.gradle.kts` if you
     want to skip push notifications for now and build without Firebase.
4. **This build requires the "Geovixa-backend-updated" project** (or the equivalent
   patch applied to your own backend) — specifically the `battery_percent`/`is_charging`
   fields on `POST /attendance/location-ping` and `GET /attendance/tracking-map`. Without
   that, the app still works fine, it just won't show battery % on the admin map.
5. Gradle Sync → Run on a device/emulator with Google Play Services (geofencing/location
   need it — a plain AOSP emulator without Play Store won't work).

### First-run flow (new)
Right after login, the employee now sees a 2-step **PermissionOnboardingScreen**:
1. Background location ("Allow all the time") — with a plain-language explanation of why
2. Battery optimization exemption — also unlocks live battery % on the admin's tracking map

This only shows once (`SecureStorage.isOnboardingComplete()` flag) — the screens are still
reachable again later from Profile → Settings if the employee skipped or wants to redo them.

## ⚠️ Backend additions still needed (small, non-breaking)

Your Node/Express backend doesn't need to change for anything that already existed
(login, punch, leave, salary, etc.) — the Android app calls the exact same endpoints.
Two new endpoints are needed for the *new* native capabilities to be fully useful:

1. `POST /api/employees/:employeeId/push-token` — store an FCM device token against
   the employee so admins can actually *send* pushes for leave-approved,
   reliever-assigned, SOS-acknowledged, new-announcement events. Right now the app
   registers the token (`notifications/GeovixaFcmService.kt`) but your backend has
   nowhere to save it yet.
2. `GET /api/attendance/tracking-map` (or reuse whatever powers the admin dashboard's
   live map today) — needed to feed real coworker markers into `LiveMapScreen.kt`.
   Currently the screen only plots the logged-in employee's own position.

## ❌ Still not done / needs your decision

- **GPS anomaly detection**: your backend already has an "impossible travel" (200km/h)
  check server-side — the app doesn't need changes for that, but if you want an
  on-device warning too, that'd hook into `LocationHelper.kt`.
- **Play Store background-location review**: Google requires a prominent in-app
  disclosure screen before requesting `ACCESS_BACKGROUND_LOCATION` if your app targets
  it for anything beyond immediate foreground use. Add that screen before requesting
  the permission in `MainActivity.kt` (currently only foreground location is
  auto-requested on launch, on purpose).
- **App icon** is a placeholder monogram — swap `drawable/ic_launcher_foreground.xml`
  and `values/ic_launcher_background.xml` for your real branding.
- **Google Maps swap**: `LiveMapScreen.kt` uses OSMdroid to avoid needing a paid Maps
  API key. If you already have Google Maps billing set up, swapping to
  `com.google.android.gms:maps-compose` is a drop-in change in that one file.

## Project structure
```
app/src/main/java/com/geovixa/app/
  data/local/      DataStore, Room, EncryptedSharedPreferences (SecureStorage)
  data/network/     Retrofit ApiService + models matching backend/routes/*.js
  location/         GPS, Geofencing, background tracking Service
  camera/           CameraX selfie capture
  biometric/        BiometricPrompt login gate
  battery/          Battery optimization exemption flow
  notifications/    FCM service + local notification channel
  workers/          Offline sync (WorkManager) + boot receiver
  ui/screens/        One Compose screen per feature
  ui/theme/          Persisted Material3 theme
  ui/nav/            Bottom-nav + NavHost wiring everything together
```
