// Registration is intentionally fire-and-forget and silent on failure — an admin whose
// browser doesn't support service workers (or blocks them) should see zero difference in
// how the app behaves; installability is a bonus, never a requirement.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

// Surfaces the browser's native "Install app" prompt via a small button in the topbar once
// Chrome/Edge/Android decide the install criteria are met (served over HTTPS, manifest +
// service worker present, some engagement heuristics) — this event doesn't fire at all on
// iOS Safari, which instead relies on the user's own Share -> "Add to Home Screen".
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'inline-flex';
});

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('pwa-install-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btn.style.display = 'none';
  });
});
