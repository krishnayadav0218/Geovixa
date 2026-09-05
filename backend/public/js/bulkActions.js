// Generic bulk-select bar wired to any table whose rows render `<input class="row-select"
// data-bulk-table="X" value="ID">` checkboxes (see app.js loadRegularization/loadIncidents/
// loadReferrals) plus a `#X-select-all` header checkbox and a `#X-bulk-bar` action bar.
// Event delegation is used throughout because app.js replaces tbody.innerHTML wholesale on
// every refresh — directly-bound listeners on individual checkboxes would be destroyed and
// silently stop working the moment the table reloads.
(function () {
  const TABLES = {
    regularization: {
      endpoint: '/regularization',
      reload: () => (typeof loadRegularization === 'function' ? loadRegularization() : null),
      actions: [
        { btnId: 'regularization-bulk-approve-btn', path: '/bulk-approve', label: 'approved' },
        { btnId: 'regularization-bulk-reject-btn', path: '/bulk-reject', label: 'rejected', confirmNote: true },
      ],
    },
    incidents: {
      endpoint: '/incidents',
      reload: () => (typeof loadIncidents === 'function' ? loadIncidents() : null),
      actions: [
        { btnId: 'incidents-bulk-reviewed-btn', path: '/bulk-review', label: 'marked reviewed', extraBody: { status: 'reviewed' } },
        { btnId: 'incidents-bulk-resolved-btn', path: '/bulk-review', label: 'marked resolved', extraBody: { status: 'resolved' } },
      ],
    },
    referrals: {
      endpoint: '/referrals',
      reload: () => (typeof loadReferrals === 'function' ? loadReferrals() : null),
      actions: [
        { btnId: 'referrals-bulk-hired-btn', path: '/bulk-update', label: 'marked hired', extraBody: { status: 'hired' } },
        { btnId: 'referrals-bulk-rejected-btn', path: '/bulk-update', label: 'rejected', extraBody: { status: 'rejected' } },
      ],
    },
  };

  const selections = { regularization: new Set(), incidents: new Set(), referrals: new Set() };

  window.refreshBulkBar = function (tableKey) {
    const sel = selections[tableKey];
    sel.clear(); // table just re-rendered with fresh rows — stale ids can't map to anything real
    updateBar(tableKey);
  };

  function updateBar(tableKey) {
    const bar = document.getElementById(`${tableKey}-bulk-bar`);
    const countEl = document.getElementById(`${tableKey}-bulk-count`);
    if (!bar || !countEl) return;
    const count = selections[tableKey].size;
    countEl.textContent = count;
    bar.classList.toggle('active', count > 0);
    const selectAll = document.getElementById(`${tableKey}-select-all`);
    if (selectAll) {
      const total = document.querySelectorAll(`.row-select[data-bulk-table="${tableKey}"]`).length;
      selectAll.checked = total > 0 && count === total;
      selectAll.indeterminate = count > 0 && count < total;
    }
  }

  // ---- checkbox clicks (event delegation on document, since rows re-render) ----
  document.addEventListener('change', (e) => {
    const target = e.target;
    if (target.matches('input.row-select[data-bulk-table]')) {
      const tableKey = target.dataset.bulkTable;
      if (target.checked) selections[tableKey].add(target.value);
      else selections[tableKey].delete(target.value);
      updateBar(tableKey);
      return;
    }
    for (const tableKey of Object.keys(TABLES)) {
      if (target.id === `${tableKey}-select-all`) {
        document.querySelectorAll(`.row-select[data-bulk-table="${tableKey}"]`).forEach((cb) => {
          cb.checked = target.checked;
          if (target.checked) selections[tableKey].add(cb.value);
          else selections[tableKey].delete(cb.value);
        });
        updateBar(tableKey);
      }
    }
  });

  // ---- action + clear buttons ----
  Object.entries(TABLES).forEach(([tableKey, config]) => {
    const clearBtn = document.getElementById(`${tableKey}-bulk-clear-btn`);
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        selections[tableKey].clear();
        document.querySelectorAll(`.row-select[data-bulk-table="${tableKey}"]`).forEach((cb) => { cb.checked = false; });
        updateBar(tableKey);
      });
    }

    config.actions.forEach((action) => {
      const btn = document.getElementById(action.btnId);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const ids = [...selections[tableKey]].map(Number);
        if (!ids.length) return;
        let note;
        if (action.confirmNote) note = prompt(`Reason for rejecting these ${ids.length} request(s) (optional):`) || '';
        if (!confirm(`${action.label === 'rejected' || action.label.includes('reject') ? 'Reject' : 'Confirm'} ${ids.length} selected item(s)?`)) return;
        try {
          const body = { ids, ...(action.extraBody || {}) };
          if (note !== undefined) body.note = note;
          const data = await apiFetch(`${config.endpoint}${action.path}`, { method: 'PUT', body: JSON.stringify(body) });
          showToast(data.message || `${ids.length} item(s) ${action.label}`);
          selections[tableKey].clear();
          config.reload();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  });
})();
