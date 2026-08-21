// Sends real FCM push notifications. Previously notifyEmployee() only wrote a row to
// the `notifications` table (the in-app feed) — nothing was ever actually pushed to the
// employee's phone, so they'd only see it if they happened to open the app.
//
// Requires a Firebase service account JSON. Set FIREBASE_SERVICE_ACCOUNT_JSON (the raw
// JSON as a single-line env var) or FIREBASE_SERVICE_ACCOUNT_PATH (a file path) in your
// environment. If neither is set, this module silently no-ops — the in-app notification
// feed still works either way, so nothing breaks for deployments that haven't set up
// Firebase yet.
let admin = null;
let initFailed = false;

function getAdmin() {
  if (admin || initFailed) return admin;
  try {
    const firebaseAdmin = require('firebase-admin');
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      credential = firebaseAdmin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      credential = firebaseAdmin.credential.cert(require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
    } else {
      initFailed = true;
      return null;
    }
    firebaseAdmin.initializeApp({ credential });
    admin = firebaseAdmin;
    return admin;
  } catch (err) {
    console.error('[push] Firebase Admin init failed — push notifications disabled:', err.message);
    initFailed = true;
    return null;
  }
}

/**
 * Sends a push to a single device token. Never throws — a push failure (expired token,
 * Firebase misconfigured, etc.) must never break the calling route's actual business
 * logic (approving leave, assigning a reliever, etc.).
 */
async function sendPush(pushToken, title, body, data = {}) {
  if (!pushToken) return { sent: false, reason: 'no_token' };
  const fbAdmin = getAdmin();
  if (!fbAdmin) return { sent: false, reason: 'not_configured' };

  try {
    await fbAdmin.messaging().send({
      token: pushToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
    });
    return { sent: true };
  } catch (err) {
    // Expired/invalid tokens are routine (app uninstalled, reinstalled, etc.) — log at
    // debug level rather than as an error flood.
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendPush };
