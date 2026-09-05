// Real-time layer for the admin panel — additive to app.js, never replaces its polling
// timers (loadSosAlerts/loadOpsMap/loadTrackingMap keep running exactly as before). If the
// socket disconnects, drops out, or the browser blocks it, the existing polling silently
// keeps everything up to date anyway — this only makes updates arrive sooner when it works.
(function () {
  let socket = null;

  function connect() {
    const token = typeof getToken === 'function' ? getToken() : sessionStorage.getItem('geovixa_token');
    if (!token || typeof io === 'undefined') return; // not logged in yet, or socket.io client failed to load

    socket = io({ auth: { token }, reconnection: true, reconnectionDelay: 2000 });

    socket.on('connect_error', () => {
      // Expected right after logout/token-expiry, or if this deployment's Socket.io got
      // blocked by a proxy — the 15-90s polling in app.js is the fallback either way.
    });

    // ---- SOS: instant push instead of the 15s poll (see startSosAutoRefresh in app.js) ----
    socket.on('sos:new', (alert) => {
      if (typeof loadSosAlerts === 'function' && document.getElementById('tab-sos') && !document.getElementById('tab-sos').classList.contains('hidden')) {
        loadSosAlerts();
      }
      if (typeof showToast === 'function') {
        showToast(`🚨 New SOS from ${alert.employee_id} (${alert.type})`, true);
      }
      playAlertSound();
    });
    socket.on('sos:updated', () => {
      if (typeof loadSosAlerts === 'function') loadSosAlerts();
    });

    // ---- Live tracking: instant push instead of the 30s poll (loadTrackingMap) ----
    socket.on('tracking:update', () => {
      const trackingTabActive = document.getElementById('tab-tracking') && !document.getElementById('tab-tracking').classList.contains('hidden');
      if (trackingTabActive && typeof loadTrackingMap === 'function') loadTrackingMap();
      if (typeof loadOverview === 'function' && document.getElementById('tab-overview') && !document.getElementById('tab-overview').classList.contains('hidden')) {
        loadOverview();
      }
    });
  }

  function playAlertSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      osc.start(); osc.stop(ctx.currentTime + 0.3);
    } catch (e) { /* audio not available — non-critical */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // app.js's own login flow calls saveSession() then re-renders — a short delay lets the
    // token exist in sessionStorage before we try to connect on first page load.
    setTimeout(connect, 300);
  });

  // app.js doesn't currently emit a custom "logged in" event, so this also re-checks whenever
  // the tab regains focus (covers the case of logging in without a full page reload).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket) connect();
  });
})();
