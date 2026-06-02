import { browser } from 'wxt/browser';
import {
  profileStorage,
  trackedPagesStorage,
  unseenJobsStorage,
  monitorStateStorage,
  UserProfile,
  TrackedPage,
  StoredJob,
  MonitorState,
  timeAgo,
  isCareerPage,
  extractReadableLabel,
  normalizeCareerUrl,
  userIdStorage,
  dismissedJobIdsStorage
} from '../../lib/storage';
import { logger } from '../../lib/logger';

// ────────────────────────────────────────────────────────
// STATE
// ────────────────────────────────────────────────────────
let profile: UserProfile | null = null;
let trackedPages: TrackedPage[] = [];
let unseenJobs: StoredJob[] = [];
let monitorState: MonitorState | null = null;
let currentFeedFilter = 'all'; // all, today, 7days, applied

// ────────────────────────────────────────────────────────
// DOM REFS
// ────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!;
const headerStatusPill = $('header-status-pill');
const headerStatusText = $('header-status-text');
const monitorToggle = $('monitor-toggle');
const monitorBadge = $('monitor-badge');
const monitorMeta = $('monitor-meta');
const feedBadge = $('feed-badge');
const toast = $('toast');
const latencyText = $('latency-text');
const latencyDot = $('latency-dot');
const telemetryStatusPill = $('telemetry-status-pill');
const telemetryStatusText = $('telemetry-status-text');

// ────────────────────────────────────────────────────────
// INIT
// ────────────────────────────────────────────────────────
async function init() {
  $('dynamic-root')?.remove(); // if any existing
  document.body.insertAdjacentHTML('afterbegin', '<div id="global-loading" style="display:flex;justify-content:center;align-items:center;height:100vh;color:#00E5FF;"><div class="spinner"></div></div>');

  // Load all initial
  [profile, trackedPages, unseenJobs, monitorState] = await Promise.all([
    profileStorage.getValue(),
    trackedPagesStorage.getValue(),
    unseenJobsStorage.getValue(),
    monitorStateStorage.getValue(),
  ]);

  if (!profile?.isOnboarded) {
    browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    window.close();
    return;
  }

  $('global-loading')?.remove();

  // Watch for changes
  profileStorage.watch(val => { if(val) { profile = val; renderMonitorState(); }});
  trackedPagesStorage.watch(val => { if(val) { trackedPages = val; renderMonitorState(); loadWatchedPages(); }});
  unseenJobsStorage.watch(val => { if(val) { unseenJobs = val; updateFeedBadge(); loadFeed(); }});
  monitorStateStorage.watch(val => { if(val) { monitorState = val; renderMonitorState(); }});

  // Setup UI
  setupTabs();
  setupTagInputs();
  setupSegmentedControls();
  setupMonitorToggle();
  setupFooter();
  
  // Initial renders
  renderMonitorState();
  updateFeedBadge();
  loadWatchedPages();
  loadFeed();
  checkCurrentTab();
  
  pingBackend();
  checkSocketStatus();

  // Listen for socket status updates
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SOCKET_STATUS') {
      renderSocketStatus(msg.connected);
    }
  });

  // Refresh "time ago" every 30s
  setInterval(() => {
    renderMonitorState();
    loadWatchedPages();
    loadFeed();
  }, 30000);
}

// ────────────────────────────────────────────────────────
// TABS
// ────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab')!;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${tab}`).classList.add('active');

      if (tab === 'watched') loadWatchedPages();
      if (tab === 'feed') {
        loadFeed();
        // Clear badge optimistically
        browser.runtime.sendMessage({ type: 'CLEAR_BADGE' });
      }
      if (tab === 'settings') loadSettings();
    });
  });
}

// ────────────────────────────────────────────────────────
// MONITOR STATE
// ────────────────────────────────────────────────────────
function renderMonitorState() {
  if (!profile || !monitorState) return;
  const active = monitorState.active;

  if (active) {
    headerStatusPill.className = 'status-pill live';
    headerStatusText.textContent = 'LIVE';
    monitorBadge.className = 'live-badge';
    monitorBadge.textContent = 'LIVE';
    monitorToggle.classList.add('on');
  } else {
    headerStatusPill.className = 'status-pill paused';
    headerStatusText.textContent = 'PAUSED';
    monitorBadge.className = 'paused-badge';
    monitorBadge.textContent = 'PAUSED';
    monitorToggle.classList.remove('on');
  }

  const ago = monitorState?.lastPollAt ? timeAgo(monitorState.lastPollAt) : 'No scan yet';
  let matchesHtml = '';
  if (monitorState?.lastCycleMatchCount > 0) {
    matchesHtml = `<br><span style="color:#00FF88;">Last scan: found ${monitorState.lastCycleMatchCount} matches</span>`;
  } else if (monitorState?.lastPollAt) {
    matchesHtml = `<br><span style="color:#5A7A9A;">Last scan: no new matches</span>`;
  }
  const tPages = trackedPages || [];
  monitorMeta.innerHTML = `Monitoring ${tPages.length} page${tPages.length !== 1 ? 's' : ''} · Last scan: ${ago}${matchesHtml}`;

  // Populate tag inputs
  renderTagsIntoWrap('roles-wrap', 'roles-input', profile?.targetRoles || []);
  renderTagsIntoWrap('locations-wrap', 'locations-input', profile?.locations || []);
  renderTagsIntoWrap('companies-wrap', 'companies-input', profile?.watchlistCompanies || []);

  // Set alert mode
  document.querySelectorAll('#alert-segmented .seg-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-val') === profile?.alertMode);
  });
}

function setupMonitorToggle() {
  monitorToggle.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'TOGGLE_MONITOR' });
  });

  const scanBtn = $('scan-open-pages-btn') as HTMLButtonElement;
  if (scanBtn) {
    scanBtn.addEventListener('click', () => {
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning...';
      browser.runtime.sendMessage({ type: 'TRIGGER_SCAN_ALL' }).then(res => {
        setTimeout(() => {
          scanBtn.disabled = false;
          scanBtn.textContent = 'Scan open pages now';
          if (res?.count) showToast(`Triggered scan on ${res.count} pages`);
          else showToast('No tracked pages are currently open');
        }, 1000);
      });
    });
  }
}

// ────────────────────────────────────────────────────────
// TAG INPUTS
// ────────────────────────────────────────────────────────
function setupTagInputs() {
  const configs: { wrapId: string; inputId: string; key: keyof UserProfile }[] = [
    { wrapId: 'roles-wrap', inputId: 'roles-input', key: 'targetRoles' },
    { wrapId: 'locations-wrap', inputId: 'locations-input', key: 'locations' },
    { wrapId: 'companies-wrap', inputId: 'companies-input', key: 'watchlistCompanies' },
  ];

  configs.forEach(({ wrapId, inputId, key }) => {
    const wrap = $(wrapId);
    const input = $(inputId) as HTMLInputElement;

    const addTag = (val: string) => {
      if (!profile) return;
      const clean = val.trim();
      const arr = (profile[key] as string[]) || [];
      if (clean && !arr.includes(clean)) {
        const changes = { [key]: [...arr, clean] };
        browser.runtime.sendMessage({ type: 'PREFS_UPDATED', changes });
      }
      input.value = '';
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(input.value); }
      if (e.key === 'Backspace' && !input.value) {
        if (!profile) return;
        const arr = (profile[key] as string[]) || [];
        if (arr.length > 0) {
          const changes = { [key]: arr.slice(0, -1) };
          browser.runtime.sendMessage({ type: 'PREFS_UPDATED', changes });
        }
      }
    });

    input.addEventListener('blur', () => {
      if (input.value) addTag(input.value);
    });

    wrap.addEventListener('click', () => input.focus());
  });
}

function renderTagsIntoWrap(wrapId: string, inputId: string, tags: string[]) {
  const wrap = $(wrapId);
  const input = $(inputId);
  if (!wrap || !input) return;
  wrap.querySelectorAll('.tag-pill').forEach(e => e.remove());
  (tags || []).forEach((val, idx) => {
    const pill = document.createElement('div');
    pill.className = 'tag-pill';
    pill.innerHTML = `<span>${escapeHtml(val)}</span><span class="tag-x">&times;</span>`;
    pill.querySelector('.tag-x')!.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!profile) return;
      const key = wrapId.replace('-wrap', '') === 'roles' ? 'targetRoles' : wrapId.replace('-wrap', '') === 'locations' ? 'locations' : 'watchlistCompanies';
      const arr = [...((profile[key as keyof UserProfile] as string[]) || [])];
      arr.splice(idx, 1);
      browser.runtime.sendMessage({ type: 'PREFS_UPDATED', changes: { [key]: arr } });
    });
    wrap.insertBefore(pill, input);
  });
}

function setupSegmentedControls() {
  document.querySelectorAll('#alert-segmented .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-val');
      if (val) browser.runtime.sendMessage({ type: 'PREFS_UPDATED', changes: { alertMode: val } });
    });
  });

  document.querySelectorAll('#feed-filter .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#feed-filter .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFeedFilter = btn.getAttribute('data-val') || 'all';
      loadFeed();
    });
  });
}

// ────────────────────────────────────────────────────────
// WATCHED PAGES
// ────────────────────────────────────────────────────────
async function checkCurrentTab() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const url = tab.url;

    if (!isCareerPage(url)) return;

    const banner = $('current-page-banner');
    const normalizedUrl = normalizeCareerUrl(url);
    const alreadyTracked = trackedPages.some(p => p.normalizedUrl === normalizedUrl);

    if (alreadyTracked) {
      banner.style.display = 'none';
      return;
    }

    banner.innerHTML = `
      <div class="add-page-banner">
        <div class="add-page-banner-text">You're on a careers page — track it?</div>
        <button class="btn-add-page" id="banner-add-btn">+ Add</button>
      </div>
    `;
    banner.style.display = 'block';

    $('banner-add-btn').addEventListener('click', async () => {
      const btn = $('banner-add-btn') as HTMLButtonElement;
      btn.disabled = true; btn.textContent = '…';
      browser.runtime.sendMessage({ type: 'ADD_TRACKED_SEARCH', url });
      banner.style.display = 'none';
    });
  } catch {}
}

async function loadWatchedPages() {
  const container = $('watched-list-container');
  if (trackedPages.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        No pages tracked yet.<br />
        Visit a careers page and click<br />"+ Track this page" or use the banner above.
      </div>
    `;
    return;
  }

  // Find which pages are currently open
  const openTabs = await browser.tabs.query({});
  const openUrls = new Set(openTabs.map(t => t.url ? normalizeCareerUrl(t.url) : ''));

  let html = '<div class="watched-list">';
  for (const s of trackedPages) {
    const isOpen = openUrls.has(s.normalizedUrl);
    
    let dotClass = isOpen ? 'ok' : 'pending';
    let dotHtml = isOpen ? `<span class="status-dot" style="animation: blink 1s step-end infinite;"></span>` : `<span class="scrape-dot ${dotClass}"></span>`;
    let statusText = isOpen ? `<span style="color:var(--green)">Active — scans every 15 min</span>` : `Open to scan`;
    
    const lastTime = s.lastScrapedAt ? timeAgo(s.lastScrapedAt) : 'pending';

      const displayUrl = s.displayUrl || s.url;
      const hasSortInjected = s.displayUrl && s.displayUrl !== s.url;

      html += `
      <div class="watched-row-wrap" style="display:flex; flex-direction:column; gap:8px;">
        <div class="watched-row">
          <div class="favicon-avatar"><img src="https://www.google.com/s2/favicons?domain=${escapeHtml(displayUrl)}&sz=16" onerror="this.style.display='none'"></div>
          <div class="watched-info">
            <div class="watched-domain" title="${escapeHtml(displayUrl)}">
              ${escapeHtml(s.label)}
              ${hasSortInjected ? `<span style="font-size:9px; background:#e0f7fa; color:#00bcd4; padding:2px 4px; border:1px solid #00bcd4; border-radius:2px; margin-left:6px; vertical-align:middle; white-space:nowrap;">↕ newest first</span>` : ''}
            </div>
            <div class="watched-meta" style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-top:6px;">
              <div style="display:flex; align-items:center; gap:6px;">
                ${dotHtml}
                <span style="font-weight:700">${statusText}</span>
              </div>
              ${!isOpen ? `<button class="btn-open-scan" data-url="${escapeHtml(s.url)}" style="background:var(--cyan); color:#fff; border:1px solid #000; padding:2px 6px; font-size:9px; cursor:pointer; font-weight:700;">OPEN & SCAN</button>` : ''}
            </div>
            ${s.lastScrapedAt ? `<div style="font-size:9px; color:#888; margin-top:2px;">Last scanned: ${lastTime}</div>` : ''}
          </div>
          ${s.newJobCount > 0 ? `<span class="new-badge">${s.newJobCount} new</span>` : ''}
          <button class="btn-trash" data-id="${s.id}" title="Remove">🗑</button>
        </div>
      </div>
    `;
  }
  html += '</div>';
  
  // Search builder modal HTML
  html += `
    <div id="search-builder-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; padding:20px; align-items:center; justify-content:center;">
      <div style="background:var(--surface); border:3px solid #000; box-shadow:5px 5px 0 #000; width:100%; max-width:320px; padding:16px;">
        <div style="font-family:var(--display); font-size:14px; font-weight:800; margin-bottom:12px; text-transform:uppercase;">Build LinkedIn Search</div>
        <input type="text" id="sb-keywords" placeholder="Keywords (e.g. Security Engineer)" style="width:100%; border:2px solid #000; padding:8px; margin-bottom:8px; font-family:var(--mono); font-size:12px; font-weight:700;" />
        <input type="text" id="sb-location" placeholder="Location (e.g. India)" style="width:100%; border:2px solid #000; padding:8px; margin-bottom:12px; font-family:var(--mono); font-size:12px; font-weight:700;" />
        <div style="font-size:10px; margin-bottom:4px; font-weight:800;">Generated URL:</div>
        <div id="sb-preview" style="background:#f0f0f0; border:1px solid #000; padding:6px; font-size:9px; word-break:break-all; margin-bottom:12px; min-height:30px;"></div>
        <div style="display:flex; gap:8px;">
          <button id="sb-cancel" style="background:#fff; border:2px solid #000; padding:6px; font-weight:800; cursor:pointer; flex:1;">Cancel</button>
          <button id="sb-add" style="background:var(--green); color:#000; border:2px solid #000; padding:6px; font-weight:800; cursor:pointer; flex:2;">Add URL</button>
        </div>
      </div>
    </div>
  `;
  
  container.innerHTML = html;

  container.querySelectorAll('.btn-trash').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!;
      browser.runtime.sendMessage({ type: 'DELETE_TRACKED_SEARCH', id });
    });
  });

  container.querySelectorAll('.btn-open-scan').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = (btn as HTMLElement).dataset.url!;
      browser.tabs.create({ url, active: false });
      btn.textContent = 'OPENING...';
      (btn as HTMLButtonElement).disabled = true;
      setTimeout(() => { loadWatchedPages(); }, 2000);
    });
  });

  const modal = $('search-builder-modal');
  const kwInput = $('sb-keywords') as HTMLInputElement;
  const locInput = $('sb-location') as HTMLInputElement;
  const preview = $('sb-preview');
  let currentTargetId = '';
  
  function updatePreview() {
    const kw = encodeURIComponent(kwInput.value.trim());
    const loc = encodeURIComponent(locInput.value.trim());
    const url = `https://www.linkedin.com/jobs/search?keywords=${kw}&location=${loc}&f_TPR=r86400`;
    preview.textContent = url;
  }
  
  container.querySelectorAll('.btn-try-search').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTargetId = (btn as HTMLElement).dataset.id!;
      modal.style.display = 'flex';
      kwInput.value = ''; locInput.value = ''; updatePreview();
    });
  });
  
  kwInput?.addEventListener('input', updatePreview);
  locInput?.addEventListener('input', updatePreview);
  
  $('sb-cancel')?.addEventListener('click', () => { modal.style.display = 'none'; });
  $('sb-add')?.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'ADD_TRACKED_SEARCH', url: preview.textContent });
    if (currentTargetId) {
      browser.runtime.sendMessage({ type: 'DELETE_TRACKED_SEARCH', id: currentTargetId });
    }
    modal.style.display = 'none';
  });
}

// ────────────────────────────────────────────────────────
// FEED TAB
// ────────────────────────────────────────────────────────
function updateFeedBadge() {
  const count = unseenJobs.filter(j => !j.seenAt && !j.dismissed).length;
  if (count > 0) {
    feedBadge.textContent = String(count > 99 ? '99+' : count);
    feedBadge.style.display = 'block';
  } else {
    feedBadge.style.display = 'none';
  }
}

function loadFeed() {
  const container = $('feed-list-container');
  const markAllBtn = $('mark-all-btn');
  let jobs = unseenJobs.filter(j => !j.dismissed && (!j.snoozedUntil || j.snoozedUntil < Date.now()));

  const now = Date.now();
  if (currentFeedFilter === 'today') {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    jobs = jobs.filter(j => j.firstSeenAt >= startOfDay.getTime());
  } else if (currentFeedFilter === '7days') {
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    jobs = jobs.filter(j => j.firstSeenAt >= weekAgo);
  }

  if (jobs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        No jobs match this filter.
      </div>
    `;
    markAllBtn.style.display = 'none';
    return;
  }

  const hasUnseen = jobs.some(j => !j.seenAt);
  markAllBtn.style.display = hasUnseen ? 'block' : 'none';

  let html = '<div class="feed-list">';
  for (const job of jobs) {
    const ago = timeAgo(job.firstSeenAt);
    html += `
      <div class="feed-card ${!job.seenAt ? 'unseen' : ''}" data-id="${job.id}" data-url="${escapeHtml(job.url)}">
        <div class="feed-card-header">
          <div class="feed-card-title">${escapeHtml(job.title)}</div>
          <div class="feed-actions">
            <button class="btn-icon btn-snooze" data-id="${job.id}" title="Snooze 1 day">⏳</button>
            <button class="btn-icon btn-apply" data-id="${job.id}" title="Mark applied">✅</button>
            <button class="btn-icon btn-dismiss" data-id="${job.id}" title="Not interested">✕</button>
          </div>
        </div>
        <div class="feed-card-meta">
          <span>${escapeHtml(job.companyName)}</span>
          <span class="dot">·</span>
          <span>${escapeHtml(job.location)}</span>
          ${job.sourceDomain ? `<span class="dot">·</span><span class="pill-mini btn-source-link" data-url="${escapeHtml(job.sourcePageUrl || job.url)}" title="View Source Page" style="cursor:pointer;">${escapeHtml(job.sourceDomain)}</span>` : ''}
        </div>
        <div style="display: flex; align-items: center; gap: 6px; margin-top: 8px;">
          ${job.matchScore ? `<span class="match-badge" style="background:${job.matchScore >= 80 ? 'var(--green)' : job.matchScore >= 60 ? 'var(--cyan)' : 'var(--amber)'};color:#000;">${job.matchScore >= 80 ? 'Strong Match' : job.matchScore >= 60 ? 'Good Match' : 'Partial Match'}</span>` : ''}
          ${job.matchReason ? `<span class="match-badge" title="${escapeHtml(job.matchReason.replace(/,/g, '\\n'))}">${escapeHtml(job.matchReason.split(',')[0].replace('role:', 'Role: ').replace('company:', 'Company: '))}</span>` : ''}
          <span class="time-label">${ago}</span>
        </div>
        ${!job.seenAt ? '<div class="new-dot"></div>' : ''}
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.feed-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Ignore clicks on action buttons or source links
      if ((e.target as HTMLElement).closest('.btn-icon') || (e.target as HTMLElement).closest('.btn-source-link')) return;
      const url = (card as HTMLElement).dataset.url!;
      const id = (card as HTMLElement).dataset.id!;
      browser.tabs.create({ url });
      browser.runtime.sendMessage({ type: 'MARK_JOB_SEEN', jobId: id });
    });
  });

  container.querySelectorAll('.btn-source-link').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = (btn as HTMLElement).dataset.url!;
      browser.tabs.create({ url });
    });
  });

  container.querySelectorAll('.btn-snooze').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!;
      browser.runtime.sendMessage({ type: 'SNOOZE_JOB', jobId: id, duration: 'tomorrow' });
    });
  });

  container.querySelectorAll('.btn-dismiss').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!;
      browser.runtime.sendMessage({ type: 'DISMISS_JOB', jobId: id });
    });
  });

  container.querySelectorAll('.btn-apply').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id!;
      const jobs = await unseenJobsStorage.getValue() || [];
      const updated = jobs.map(j => j.id === id ? { ...j, applicationStatus: 'applied', appliedAt: Date.now() } : j);
      await unseenJobsStorage.setValue(updated as any);
      showToast('Marked as applied!');
      loadFeed();
    });
  });

  // Event listener for status update (when currentFeedFilter === 'applied')
  container.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const id = (sel as HTMLElement).dataset.id!;
      const val = (e.target as HTMLSelectElement).value;
      const jobs = await unseenJobsStorage.getValue() || [];
      const updated = jobs.map(j => j.id === id ? { ...j, applicationStatus: val } : j);
      await unseenJobsStorage.setValue(updated as any);
      loadFeed();
    });
  });

  markAllBtn.onclick = () => browser.runtime.sendMessage({ type: 'MARK_ALL_SEEN' });
}

// ────────────────────────────────────────────────────────
// SETTINGS
// ────────────────────────────────────────────────────────
async function loadSettings() {
  if (!profile) return;
  const userId = await userIdStorage.getValue();
  
  const nameEl = $('settings-account-name');
  if (nameEl) nameEl.textContent = `${profile.name} (${profile.email})`;
  const idEl = $('settings-account-id');
  if (idEl) idEl.textContent = `ID: ${userId || 'Not generated'}`;
  
  const emailToggle = $('settings-email-toggle');
  if (emailToggle) {
    emailToggle.classList.toggle('on', !!profile.emailAlerts);
    emailToggle.onclick = () => {
      const next = !emailToggle.classList.contains('on');
      emailToggle.classList.toggle('on', next);
      browser.runtime.sendMessage({ type: 'PREFS_UPDATED', changes: { emailAlerts: next } });
    };
  }

  const exportBtn = $('btn-export-data');
  if (exportBtn) {
    exportBtn.onclick = async () => {
      const data = {
        exportedAt: new Date().toISOString(),
        profile,
        trackedPages,
        jobs: unseenJobs,
        monitorState
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      await browser.downloads.download({ url, filename: `nextrole-export-${new Date().toISOString().split('T')[0]}.json` });
    };
  }

  const clearBtn = $('btn-clear-history');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      if (confirm('Are you sure you want to clear your entire job history? This cannot be undone.')) {
        await unseenJobsStorage.setValue([]);
        await dismissedJobIdsStorage.setValue([]);
        browser.runtime.sendMessage({ type: 'UPDATE_BADGE' });
        showToast('History cleared');
        loadFeed();
      }
    };
  }

  const resetBtn = $('btn-reset-ext');
  if (resetBtn) {
    resetBtn.onclick = async () => {
      if (confirm('DANGER: Reset extension? All settings and data will be permanently deleted.')) {
        if (confirm('Are you ABSOLUTELY sure?')) {
          await browser.storage.local.clear();
          browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
          window.close();
        }
      }
    };
  }

  // Load Activity Logs
  const logConsole = $('activity-log-console');
  const clearLogsBtn = $('btn-clear-logs');
  if (logConsole && clearLogsBtn) {
    const logs = await logger.getLogs();
    if (logs.length === 0) {
      logConsole.innerHTML = '<div style="color: #666; font-style: italic;">No recent activity</div>';
    } else {
      logConsole.innerHTML = logs.map(l => {
        const time = new Date(l.timestamp).toLocaleTimeString([], { hour12: false });
        const color = l.level === 'error' ? '#ff6b81' : l.level === 'warn' ? '#f1c40f' : '#00E5FF';
        return `<div style="margin-bottom: 4px;"><span style="color: #888;">[${time}]</span> <span style="color: ${color};">[${l.context}]</span> ${escapeHtml(l.message)}</div>`;
      }).join('');
    }
    
    clearLogsBtn.onclick = async () => {
      await logger.clearLogs();
      logConsole.innerHTML = '<div style="color: #666; font-style: italic;">No recent activity</div>';
    };
  }
}

// ────────────────────────────────────────────────────────
// FOOTER
// ────────────────────────────────────────────────────────
function setupFooter() {
  $('manage-profile-link').addEventListener('click', () => {
    browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    window.close();
  });
}

function pingBackend() {
  browser.runtime.sendMessage({ type: 'PING' }).then(res => {
    if (res?.online) {
      latencyText.textContent = `Backend: ${res.latency}ms ✓`;
      latencyDot.className = 'latency-dot ' + (res.latency < 100 ? 'green' : res.latency < 300 ? 'yellow' : 'red');
    } else {
      latencyText.textContent = 'Backend: offline ✗';
      latencyDot.className = 'latency-dot red';
    }
  }).catch(() => {
    latencyText.textContent = 'Backend: offline ✗';
    latencyDot.className = 'latency-dot red';
  });
}

function checkSocketStatus() {
  browser.runtime.sendMessage({ type: 'GET_SOCKET_STATUS' }).then(res => {
    if (res !== undefined) renderSocketStatus(res.connected);
  }).catch(() => {});
}

function renderSocketStatus(connected: boolean) {
  if (!telemetryStatusPill || !telemetryStatusText) return;
  if (connected) {
    telemetryStatusPill.className = 'status-pill live';
    telemetryStatusPill.style.background = 'var(--cyan)';
    telemetryStatusPill.style.color = '#fff';
    telemetryStatusText.textContent = 'SYNCING';
  } else {
    telemetryStatusPill.className = 'status-pill paused';
    telemetryStatusPill.style.background = '#ccc';
    telemetryStatusPill.style.color = '#000';
    telemetryStatusText.textContent = 'OFFLINE';
  }
}

function escapeHtml(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// ────────────────────────────────────────────────────────
// ERROR BOUNDARY
// ────────────────────────────────────────────────────────
window.addEventListener('error', (e) => {
  console.error('[NextRole] Popup error:', e.error);
  document.body.innerHTML = `
    <div style="padding: 20px; font-family: 'IBM Plex Mono', monospace; background: #050D17; color: #E2EAF4; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center;">
      <div style="font-size: 24px;">⚡</div>
      <div style="font-size: 13px; color: #00E5FF;">NextRole encountered an error</div>
      <div style="font-size: 11px; color: #5A7A9A;">${e.error?.message || 'Unknown error'}</div>
      <button onclick="window.location.reload()" style="background: transparent; border: 1px solid #00E5FF; color: #00E5FF; padding: 6px 16px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 11px;">Retry</button>
      <button onclick="chrome.runtime.openOptionsPage?.()" style="background: transparent; border: 1px solid #1A2E4A; color: #5A7A9A; padding: 6px 16px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 11px;">Reset extension</button>
    </div>
  `;
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[NextRole] Unhandled rejection:', e.reason);
});

init();
