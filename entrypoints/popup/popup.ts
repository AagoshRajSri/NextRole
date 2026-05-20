// ─────────────────────────────────────────────────────────
//  NextRole Popup — System Console v3
// ─────────────────────────────────────────────────────────

interface SavedSearch { id: string; companyName: string; url: string; createdAt: number; }
interface WatchlistEntry { id: string; company: string; role: string; createdAt: number; }

interface MonitorConfig {
  active: boolean;
  mode: 'keywords' | 'all';
  roles: string[];
  stack: string[];
  location: string;
  autoApply: boolean;
  instantAlerts: boolean;
}

const DEFAULT_CONFIG: MonitorConfig = {
  active: false,
  mode: 'keywords',
  roles: ['Software Engineer', 'Intern'],
  stack: ['Node.js', 'Java', 'TypeScript'],
  location: 'anywhere-india',
  autoApply: false,
  instantAlerts: true,
};

// ── State ──────────────────────────────────────────────
let config: MonitorConfig = { ...DEFAULT_CONFIG };

// ── Boot ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await ensureUserId();
  
  const isOnboarded = await checkOnboarding();
  if (!isOnboarded) {
    return; // Wait for user to complete onboarding
  }
  
  await bootApp();
});

// ── Smart Onboarding ───────────────────────────────────
// Checks masterProfile AND monitorConfig. If monitorConfig already
// has roles/stack data (user already configured the monitoring tab),
// we auto-create masterProfile from it and skip onboarding entirely.
async function checkOnboarding(): Promise<boolean> {
  const data = await browser.storage.local.get(['masterProfile', 'monitorConfig']) as any;
  
  // Already onboarded
  if (data?.masterProfile?.isOnboarded) {
    return true;
  }
  
  // Auto-populate from existing monitorConfig if it has real data
  const mc = data?.monitorConfig;
  if (mc && (mc.roles?.length > 0 || mc.stack?.length > 0)) {
    const masterProfile = {
      isOnboarded: true,
      roles: mc.roles || [],
      stack: mc.stack || [],
      experience: 'Intern / Entry-Level',
      locations: mc.location ? [mc.location] : ['bangalore']
    };
    await browser.storage.local.set({ masterProfile });
    console.log('[NextRole] Auto-populated masterProfile from existing monitorConfig. Skipping onboarding.');
    return true;
  }
  
  // Show onboarding overlay
  document.getElementById('onboarding-overlay')?.classList.add('active');
  
  // Wire save button
  const btn = document.getElementById('ob-save-btn');
  btn?.addEventListener('click', async () => {
    const rolesStr = (document.getElementById('ob-roles') as HTMLInputElement).value || '';
    const stackStr = (document.getElementById('ob-stack') as HTMLInputElement).value || '';
    const exp = (document.getElementById('ob-experience') as HTMLSelectElement).value || 'Intern / Entry-Level';
    
    // get checked locations
    const cbs = document.querySelectorAll('.ob-cb input:checked');
    const locs: string[] = [];
    cbs.forEach(cb => locs.push((cb as HTMLInputElement).value));
    
    const roles = rolesStr ? rolesStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    const stack = stackStr ? stackStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    
    const masterProfile = {
      isOnboarded: true,
      roles,
      stack,
      experience: exp,
      locations: locs.length > 0 ? locs : []
    };
    
    await browser.storage.local.set({ masterProfile });
    
    // Also seed monitorConfig with the same data so monitoring tab is pre-filled
    const seedConfig: MonitorConfig = {
      ...DEFAULT_CONFIG,
      roles,
      stack,
      location: locs[0] || 'anywhere-india',
    };
    await browser.storage.local.set({ monitorConfig: seedConfig });
    config = seedConfig;
    
    // hide overlay
    document.getElementById('onboarding-overlay')?.classList.remove('active');
    
    // emit signal
    browser.runtime.sendMessage({ action: 'MASTER_PROFILE_MUTATED', profile: masterProfile });
    
    // boot the rest of the app
    await bootApp();
  });
  
  return false;
}

async function bootApp() {
  await loadConfig();

  renderUI();
  wireNavTabs();
  wireSegControl();
  wireTagInputs();
  wireToggles();
  wireLaunchBtn();
  wireProfileForm();
  wireWatchlist();

  // Kick off career feed render
  await renderChannelList();
  await renderWatchlist();

  // Live latency measurement
  measureLatency();
}

// ── User ID ────────────────────────────────────────────
async function ensureUserId() {
  const data = await browser.storage.local.get('userId') as any;
  if (!data?.userId) {
    await browser.storage.local.set({ userId: `usr-${Math.random().toString(36).slice(2, 11)}` });
  }
}

async function getUserId(): Promise<string> {
  const d = await browser.storage.local.get('userId') as any;
  return d?.userId ?? 'default-user';
}

// ── Config persistence ─────────────────────────────────
async function loadConfig() {
  const d = await browser.storage.local.get('monitorConfig') as any;
  if (d?.monitorConfig) {
    config = { ...DEFAULT_CONFIG, ...d.monitorConfig };
  }
}

async function saveConfig() {
  await browser.storage.local.set({ monitorConfig: config });
  
  // Bidirectional sync: keep masterProfile in sync with monitoring config
  await syncMasterProfile();
}

// Sync monitoring config changes into masterProfile so content script
// scoring always uses the latest roles/stack/locations
async function syncMasterProfile() {
  const d = await browser.storage.local.get('masterProfile') as any;
  const existing = d?.masterProfile || {};
  
  const updated = {
    ...existing,
    isOnboarded: true,
    roles: config.roles,
    stack: config.stack,
    locations: existing.locations || [config.location],
  };
  
  await browser.storage.local.set({ masterProfile: updated });
  
  // Notify content scripts
  browser.runtime.sendMessage({ action: 'MASTER_PROFILE_MUTATED', profile: updated }).catch(() => {});
}

// ── Render all UI from state ────────────────────────────
function renderUI() {
  renderTags('roles', config.roles);
  renderTags('stack', config.stack);

  const locSel = document.getElementById('location-select') as HTMLSelectElement;
  if (locSel) locSel.value = config.location;

  setToggle('toggle-autoapply', config.autoApply);
  setToggle('toggle-alerts', config.instantAlerts);
  updateSlotBadge();
  updateMonitorStatus();
}

// ── Tags ───────────────────────────────────────────────
function renderTags(type: 'roles' | 'stack', items: string[]) {
  const wrap = document.getElementById(`${type}-tags`);
  if (!wrap) return;
  wrap.innerHTML = '';
  items.forEach(item => {
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.innerHTML = `${escHtml(item)}<span class="rm" data-tag="${escHtml(item)}" data-type="${type}">×</span>`;
    tag.querySelector('.rm')?.addEventListener('click', async () => {
      if (type === 'roles') config.roles = config.roles.filter(r => r !== item);
      else config.stack = config.stack.filter(s => s !== item);
      await saveConfig();
      renderTags(type, type === 'roles' ? config.roles : config.stack);
      updateSlotBadge();
    });
    wrap.appendChild(tag);
  });
}

function wireTagInputs() {
  wireOneTagInput('roles-input', 'roles-add', 'roles');
  wireOneTagInput('stack-input', 'stack-add', 'stack');
}

function wireOneTagInput(inputId: string, btnId: string, type: 'roles' | 'stack') {
  const input = document.getElementById(inputId) as HTMLInputElement;
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;

  const add = async () => {
    const val = input.value.trim();
    if (!val) return;
    const arr = type === 'roles' ? config.roles : config.stack;
    if (!arr.includes(val)) {
      arr.push(val);
      await saveConfig();
      renderTags(type, arr);
      updateSlotBadge();
    }
    input.value = '';
  };

  btn.addEventListener('click', add);
  input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') add(); });
}

function updateSlotBadge() {
  const total = config.roles.length + config.stack.length;
  const badge = document.getElementById('slot-badge');
  if (badge) badge.textContent = `${total}/10 SLOTS`;
}

// ── Toggles ────────────────────────────────────────────
function setToggle(id: string, on: boolean) {
  const el = document.getElementById(id);
  if (!el) return;
  if (on) el.classList.add('on');
  else el.classList.remove('on');
}

function wireToggles() {
  document.querySelectorAll<HTMLElement>('.toggle-switch').forEach(el => {
    el.addEventListener('click', async () => {
      const key = el.dataset.key as 'autoApply' | 'instantAlerts';
      (config as any)[key] = !(config as any)[key];
      setToggle(el.id, (config as any)[key]);
      await saveConfig();

      // Sync instantAlerts flag to background service worker
      if (key === 'instantAlerts') {
        browser.runtime.sendMessage({ action: 'setAlerts', enabled: config.instantAlerts });
      }
    });
  });

  // Location select
  const locSel = document.getElementById('location-select') as HTMLSelectElement;
  if (locSel) {
    locSel.addEventListener('change', async () => {
      config.location = locSel.value;
      await saveConfig();
    });
  }
}

// ── Segmented control ──────────────────────────────────
function wireSegControl() {
  document.querySelectorAll<HTMLElement>('.seg-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      config.mode = btn.dataset.mode as 'keywords' | 'all';
      await saveConfig();

      // Show/hide keyword groups based on mode
      const rolesGroup = document.getElementById('roles-group');
      const stackGroup = document.getElementById('stack-group');
      const isKeywords = config.mode === 'keywords';
      if (rolesGroup) rolesGroup.style.display = isKeywords ? '' : 'none';
      if (stackGroup) stackGroup.style.display = isKeywords ? '' : 'none';
    });
  });
}

// ── Launch button ──────────────────────────────────────
function updateMonitorStatus() {
  const el = document.getElementById('monitor-status');
  const btn = document.getElementById('launch-btn');
  if (el) el.classList.toggle('show', config.active);
  if (btn) {
    if (config.active) {
      btn.classList.add('active-state');
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="6" width="12" height="12"/></svg> STOP MONITOR`;
    } else {
      btn.classList.remove('active-state');
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 11l-4 4 4 4M15 13l4-4-4-4M13 4l-2 16"/></svg> LAUNCH MONITOR`;
    }
  }
}

function wireLaunchBtn() {
  const btn = document.getElementById('launch-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    config.active = !config.active;
    await saveConfig();
    updateMonitorStatus();

    // Notify the background service worker to start/stop keyword scanning
    browser.runtime.sendMessage({
      action: config.active ? 'startMonitor' : 'stopMonitor',
      config: {
        mode: config.mode,
        roles: config.roles,
        stack: config.stack,
        location: config.location,
        instantAlerts: config.instantAlerts,
      }
    });
  });
}

// ── Navigation tabs ─────────────────────────────────────
function wireNavTabs() {
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const viewId = `view-${btn.dataset.view}`;
      document.querySelectorAll<HTMLElement>('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(viewId)?.classList.add('active');

      if (btn.dataset.view === 'career-feed') {
        renderChannelList();
        renderWatchlist();
      }
      if (btn.dataset.view === 'architect') loadProfileData();
    });
  });
}

// ── Career Feed ─────────────────────────────────────────
async function renderChannelList() {
  const container = document.getElementById('channel-list');
  const countEl = document.getElementById('channel-count');
  if (!container) return;

  const d = await browser.storage.local.get('savedSearches') as any;
  const searches: SavedSearch[] = d?.savedSearches ?? [];

  if (countEl) countEl.textContent = `${searches.length} TRACKED`;

  if (searches.length === 0) {
    container.innerHTML = `<div class="empty-state">No channels tracked yet.<br/>Visit a job board and click Track.</div>`;
    return;
  }

  container.innerHTML = '';
  const sorted = [...searches].sort((a, b) => b.createdAt - a.createdAt);

  sorted.forEach(s => {
    const card = document.createElement('div');
    card.className = 'channel-card';
    const initial = s.companyName?.charAt(0) ?? '?';
    const shortUrl = cleanUrl(s.url);
    card.innerHTML = `
      <div class="channel-av">${initial}</div>
      <div class="channel-info">
        <div class="channel-name">${escHtml(s.companyName)}</div>
        <div class="channel-url" data-url="${escHtml(s.url)}">${escHtml(shortUrl)}</div>
      </div>
      <div class="ch-actions">
        <button class="ch-btn open" title="Open">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
        <button class="ch-btn del" title="Remove" data-id="${s.id}" data-url="${escHtml(s.url)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;

    card.querySelector('.channel-url')?.addEventListener('click', () => browser.tabs.create({ url: s.url }));
    card.querySelector('.open')?.addEventListener('click', () => browser.tabs.create({ url: s.url }));
    card.querySelector('.del')?.addEventListener('click', async () => {
      card.style.opacity = '0';
      card.style.transform = 'scale(0.95)';
      card.style.transition = 'all 0.25s ease';
      setTimeout(async () => {
        const cur = await browser.storage.local.get('savedSearches') as any;
        const updated = ((cur?.savedSearches ?? []) as SavedSearch[]).filter(x => x.id !== s.id);
        await browser.storage.local.set({ savedSearches: updated });
        await renderChannelList();
      }, 250);
    });

    container.appendChild(card);
  });
}

// ── Company Watchlist ───────────────────────────────────
function wireWatchlist() {
  const addBtn = document.getElementById('wl-add-btn');
  if (!addBtn) return;

  addBtn.addEventListener('click', async () => {
    const companyInput = document.getElementById('wl-company') as HTMLInputElement;
    const roleInput = document.getElementById('wl-role') as HTMLInputElement;
    if (!companyInput || !roleInput) return;

    const company = companyInput.value.trim();
    const role = roleInput.value.trim();
    if (!company && !role) return;

    const entry: WatchlistEntry = {
      id: `wl-${Date.now()}`,
      company: company || '',
      role: role || '',
      createdAt: Date.now()
    };

    const d = await browser.storage.local.get('companyWatchlist') as any;
    const list: WatchlistEntry[] = d?.companyWatchlist ?? [];
    list.push(entry);
    await browser.storage.local.set({ companyWatchlist: list });

    companyInput.value = '';
    roleInput.value = '';

    await renderWatchlist();
  });

  // Enter key support on both inputs
  const companyInput = document.getElementById('wl-company') as HTMLInputElement;
  const roleInput = document.getElementById('wl-role') as HTMLInputElement;
  const triggerAdd = (e: KeyboardEvent) => { if (e.key === 'Enter') addBtn.click(); };
  companyInput?.addEventListener('keydown', triggerAdd);
  roleInput?.addEventListener('keydown', triggerAdd);
}

async function renderWatchlist() {
  const container = document.getElementById('wl-list');
  const countEl = document.getElementById('wl-count');
  if (!container) return;

  const d = await browser.storage.local.get('companyWatchlist') as any;
  const list: WatchlistEntry[] = d?.companyWatchlist ?? [];

  if (countEl) countEl.textContent = `${list.length} WATCHING`;

  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: 16px;">No watchlist entries yet.<br/>Add a company + role to get notified.</div>`;
    return;
  }

  container.innerHTML = '';
  const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);

  sorted.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'channel-card';
    const initial = entry.company ? entry.company.charAt(0).toUpperCase() : '🎯';
    const label = [entry.company, entry.role].filter(Boolean).join(' — ');
    card.innerHTML = `
      <div class="channel-av" style="background: rgba(240,255,0,0.08); border-color: rgba(240,255,0,0.25); color: var(--yellow);">${escHtml(String(initial))}</div>
      <div class="channel-info">
        <div class="channel-name">${escHtml(entry.company || 'Any Company')}</div>
        <div class="channel-url" style="color: var(--yellow);">${escHtml(entry.role || 'Any Role')}</div>
      </div>
      <div class="ch-actions">
        <button class="ch-btn del" title="Remove" data-id="${entry.id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;

    card.querySelector('.del')?.addEventListener('click', async () => {
      card.style.opacity = '0';
      card.style.transform = 'scale(0.95)';
      card.style.transition = 'all 0.25s ease';
      setTimeout(async () => {
        const cur = await browser.storage.local.get('companyWatchlist') as any;
        const updated = ((cur?.companyWatchlist ?? []) as WatchlistEntry[]).filter(x => x.id !== entry.id);
        await browser.storage.local.set({ companyWatchlist: updated });
        await renderWatchlist();
      }, 250);
    });

    container.appendChild(card);
  });
}

// ── Architect / Profile ─────────────────────────────────
async function loadProfileData() {
  try {
    const userId = await getUserId();
    const res = await fetch(`http://localhost:5000/api/profile`, { headers: { 'X-User-Id': userId } });
    if (!res.ok) return;
    const d = await res.json();
    (document.getElementById('prof-skills') as HTMLInputElement).value = d.skills ?? '';
    (document.getElementById('prof-experience') as HTMLTextAreaElement).value = d.experience ?? '';
    (document.getElementById('prof-education') as HTMLTextAreaElement).value = d.education ?? '';
    (document.getElementById('prof-projects') as HTMLTextAreaElement).value = d.projects ?? '';
  } catch { /* backend offline */ }
}

function wireProfileForm() {
  const btn = document.getElementById('save-profile-btn') as HTMLButtonElement;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const userId = await getUserId();
    const body = {
      skills: (document.getElementById('prof-skills') as HTMLInputElement).value,
      experience: (document.getElementById('prof-experience') as HTMLTextAreaElement).value,
      education: (document.getElementById('prof-education') as HTMLTextAreaElement).value,
      projects: (document.getElementById('prof-projects') as HTMLTextAreaElement).value,
    };
    btn.textContent = 'SAVING...';
    btn.disabled = true;
    try {
      const res = await fetch('http://localhost:5000/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(body),
      });
      btn.textContent = res.ok ? '✓ SAVED!' : '✗ FAILED';
    } catch {
      btn.textContent = '✗ OFFLINE';
    } finally {
      setTimeout(() => { btn.textContent = 'SAVE MASTER RESUME'; btn.disabled = false; }, 2000);
    }
  });
}

// ── Latency pinger ─────────────────────────────────────
async function measureLatency() {
  const el = document.getElementById('latency-display');
  if (!el) return;
  try {
    const t0 = Date.now();
    await fetch('http://localhost:5000/api/health', { method: 'GET' });
    const ms = Date.now() - t0;
    el.textContent = `LATENCY: ${ms}MS`;
    el.style.color = ms < 100 ? '#00c851' : ms < 300 ? '#ffb700' : '#f87171';
  } catch {
    el.textContent = `LATENCY: --MS`;
    el.style.color = '#f87171';
  }
}

// ── Helpers ────────────────────────────────────────────
function cleanUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    let s = u.hostname + (u.pathname !== '/' ? u.pathname : '');
    return s.length > 42 ? s.slice(0, 39) + '...' : s;
  } catch { return urlStr; }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
