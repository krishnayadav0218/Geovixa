// Draws into the 3 canvases added to the Overview tab (index.html #overview-trends-panel).
// Hooks into the SAME loadOverview() app.js already calls on login and on switching to the
// Overview tab — no new nav wiring needed, this just piggybacks on that existing call.
(function () {
  let attendanceChart = null;
  let otCostChart = null;
  let projectCostChart = null;

  const CHART_COLORS = { line: '#4f46e5', bar: '#16a34a', barAlt: ['#4f46e5', '#16a34a', '#f59e0b', '#dc2626', '#0ea5e9', '#a855f7', '#ea580c'] };

  async function loadTrendCharts() {
    if (typeof Chart === 'undefined') return; // CDN blocked/offline — Overview's core stats still work fine without this
    try {
      const [attendance, otTrend, projectCost] = await Promise.all([
        apiFetch('/analytics/attendance-trend?days=30'),
        apiFetch('/analytics/overtime-cost-trend?days=30'),
        apiFetch('/analytics/project-cost-comparison?days=30'),
      ]);
      renderAttendanceTrend(attendance.points || []);
      renderOtCostTrend(otTrend.points || []);
      renderProjectCost(projectCost.projects || []);
    } catch (err) {
      // Non-fatal — the Overview tab's core stat cards / live table already loaded fine via
      // loadOverview(); charts are a supplementary view, not a hard dependency.
      console.warn('[dashboardCharts] failed to load trend data:', err.message);
    }
  }

  function renderAttendanceTrend(points) {
    const ctx = document.getElementById('chart-attendance-trend');
    if (!ctx) return;
    if (attendanceChart) attendanceChart.destroy();
    attendanceChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: points.map(p => p.date),
        datasets: [{
          label: 'Employees Present', data: points.map(p => p.present_count),
          borderColor: CHART_COLORS.line, backgroundColor: 'rgba(79,70,229,0.1)',
          tension: 0.3, fill: true, pointRadius: 2,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  }

  function renderOtCostTrend(points) {
    const ctx = document.getElementById('chart-overtime-cost-trend');
    if (!ctx) return;
    if (otCostChart) otCostChart.destroy();
    otCostChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: points.map(p => p.date),
        datasets: [{
          label: 'OT Cost (₹)', data: points.map(p => p.total_amount),
          borderColor: CHART_COLORS.bar, backgroundColor: 'rgba(22,163,74,0.1)',
          tension: 0.3, fill: true, pointRadius: 2,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  }

  function renderProjectCost(projects) {
    const ctx = document.getElementById('chart-project-cost');
    if (!ctx) return;
    if (projectCostChart) projectCostChart.destroy();
    projectCostChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: projects.map(p => p.project),
        datasets: [{
          label: 'OT Cost (₹)', data: projects.map(p => p.total_amount),
          backgroundColor: projects.map((_, i) => CHART_COLORS.barAlt[i % CHART_COLORS.barAlt.length]),
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } },
    });
  }

  // Wrap the existing loadOverview so switching to (or landing on) the Overview tab also
  // refreshes the charts — done this way, rather than editing app.js directly, so a future
  // update to app.js's loadOverview body doesn't need to remember to keep this call in sync.
  // IMPORTANT: this runs immediately (not inside a DOMContentLoaded listener) because this
  // script tag executes right after app.js's, synchronously, during the initial HTML parse —
  // app.js's own DOMContentLoaded handler (which fires the FIRST loadOverview() call after
  // login) runs after that, so the wrap has to already be in place before then, or the very
  // first Overview render would show stats without charts until the next tab switch.
  if (typeof window.loadOverview === 'function') {
    const originalLoadOverview = window.loadOverview;
    window.loadOverview = async function () {
      await originalLoadOverview();
      loadTrendCharts();
    };
  }
})();
