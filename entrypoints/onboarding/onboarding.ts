import { browser } from 'wxt/browser';
import { profileStorage, trackedPagesStorage, unseenJobsStorage, monitorStateStorage, userIdStorage, UserProfile, timeAgo } from '../../lib/storage';

const API_BASE = 'http://localhost:5000';

// ────────────────────────────────────────────────────────
// VIEWS
// ────────────────────────────────────────────────────────
type View = 'loading' | 'wizard' | 'dashboard' | 'edit';

let currentView: View = 'loading';
let currentStep = 1;
const totalSteps = 6;

const profileData: Partial<UserProfile> & {
  targetRoles: string[]; locations: string[]; watchlistCompanies: string[];
} = {
  name: '', phone: '', email: '', linkedinUrl: '',
  targetRoles: [], locations: [], watchlistCompanies: [],
  experienceLevel: 'fresher', alertMode: 'instant', emailAlerts: false,
};

// ────────────────────────────────────────────────────────
// MOUNT — CHECK STORAGE FIRST
// ────────────────────────────────────────────────────────
async function mount() {
  showLoading();
  try {
    const profile = await profileStorage.getValue();
    if (profile?.isOnboarded) {
      await showDashboard(profile);
    } else {
      if (profile) {
        // Pre-fill wizard with existing partial data
        Object.assign(profileData, profile);
      }
      showWizard();
    }
  } catch (e) {
    showWizard(); // fallback
  }
}

function showLoading() {
  currentView = 'loading';
  setRoot(`
    <div class="loading-full">
      <div class="spinner-lg"></div>
      <div class="loading-text">Loading NextRole…</div>
    </div>
  `);
}

// ────────────────────────────────────────────────────────
// DASHBOARD VIEW
// ────────────────────────────────────────────────────────
async function showDashboard(profile: UserProfile) {
  currentView = 'dashboard';
  const [pages, jobs, monitorState] = await Promise.all([
    trackedPagesStorage.getValue(),
    unseenJobsStorage.getValue(),
    monitorStateStorage.getValue(),
  ]);
  const initials = getInitials(profile.name);
  const recentJobs = (jobs ?? []).filter(j => !j.dismissed).slice(0, 5);

  setRoot(`
    <div class="dashboard">
      <div class="db-header">
        <div class="db-avatar">${initials}</div>
        <div class="db-identity">
          <div class="db-name">${esc(profile.name || 'Your Profile')}</div>
          <div class="db-sub">${esc(profile.email || '')}${profile.phone ? ' · ' + esc(profile.phone) : ''}</div>
          ${profile.linkedinUrl ? `<a class="db-linkedin" href="${esc(profile.linkedinUrl)}" target="_blank">LinkedIn ↗</a>` : ''}
        </div>
        <button class="btn-edit" id="btn-edit">✏ Edit</button>
      </div>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-num">${(pages ?? []).length}</div>
          <div class="stat-lbl">Pages tracked</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${monitorState?.totalJobsFound ?? 0}</div>
          <div class="stat-lbl">Jobs found</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${monitorState?.totalAlertsCount ?? 0}</div>
          <div class="stat-lbl">Alerts sent</div>
        </div>
      </div>

      <div class="section-card">
        <div class="section-title">Preferences</div>
        <div class="pref-group">
          <div class="pref-label">Target Roles</div>
          <div class="pill-row">${(profile.targetRoles ?? []).map(r => `<span class="pill cyan">${esc(r)}</span>`).join('') || '<span class="pref-empty">None</span>'}</div>
        </div>
        <div class="pref-group">
          <div class="pref-label">Locations</div>
          <div class="pill-row">${(profile.locations ?? []).map(l => `<span class="pill green">${esc(l)}</span>`).join('') || '<span class="pref-empty">Any</span>'}</div>
        </div>
        <div class="pref-group">
          <div class="pref-label">Watchlist Companies</div>
          <div class="pill-row">${(profile.watchlistCompanies ?? []).map(c => `<span class="pill amber">${esc(c)}</span>`).join('') || '<span class="pref-empty">None set</span>'}</div>
        </div>
        <div class="pref-row-inline">
          <span class="pref-label">Experience</span>
          <span class="badge-inline">${profile.experienceLevel ?? '—'}</span>
        </div>
        <div class="pref-row-inline">
          <span class="pref-label">Alert Mode</span>
          <span class="badge-inline">${profile.alertMode ?? 'instant'}</span>
        </div>
      </div>

      <div class="section-card">
        <div class="section-title">Tracked Pages</div>
        ${(pages ?? []).length === 0
          ? '<div class="empty-hint">No pages tracked yet — visit a careers page and click "+ Track"</div>'
          : (pages ?? []).map(p => `
            <div class="page-row">
              <div class="page-avatar">${p.label.charAt(0).toUpperCase()}</div>
              <div class="page-info">
                <div class="page-label">${esc(p.label)}</div>
                <div class="page-sub">${esc(p.subtitle)} · ${p.lastScrapedAt ? timeAgo(p.lastScrapedAt) : 'pending'}</div>
              </div>
              ${p.newJobCount > 0 ? `<span class="new-badge">${p.newJobCount} new</span>` : ''}
              <button class="btn-rm" data-id="${p.id}">🗑</button>
            </div>
          `).join('')}
      </div>

      ${recentJobs.length > 0 ? `
        <div class="section-card">
          <div class="section-title">Recent Matches</div>
          ${recentJobs.map(j => `
            <div class="job-row" data-url="${esc(j.url)}">
              <div class="job-title">${esc(j.title)}</div>
              <div class="job-meta">${esc(j.companyName)} · ${esc(j.location)} · <span class="match-chip">${esc(j.matchReason)}</span></div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="db-footer">
        <button class="btn-ghost" id="btn-back-wizard">← Back to setup</button>
        <button class="btn-primary" id="btn-open-popup">Open popup ↗</button>
      </div>
    </div>
  `);

  document.getElementById('btn-edit')?.addEventListener('click', () => showEdit(profile));
  document.getElementById('btn-back-wizard')?.addEventListener('click', () => {
    Object.assign(profileData, profile);
    showWizard();
  });
  document.getElementById('btn-open-popup')?.addEventListener('click', () => window.close());
  document.querySelectorAll('.btn-rm').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id!;
      const pages = await trackedPagesStorage.getValue() ?? [];
      await trackedPagesStorage.setValue(pages.filter(p => p.id !== id));
      fetch(`${API_BASE}/api/tracked-searches/${id}`, { method: 'DELETE' }).catch(() => {});
      const updated = await profileStorage.getValue();
      if (updated) await showDashboard(updated);
    });
  });
  document.querySelectorAll('.job-row').forEach(row => {
    row.addEventListener('click', () => {
      const url = (row as HTMLElement).dataset.url;
      if (url) window.open(url, '_blank');
    });
  });
}

// ────────────────────────────────────────────────────────
// EDIT VIEW
// ────────────────────────────────────────────────────────
function showEdit(profile: UserProfile) {
  currentView = 'edit';
  const editData = { ...profile };

  setRoot(`
    <div class="edit-form">
      <div class="edit-header">
        <button class="btn-ghost" id="btn-cancel-edit">← Cancel</button>
        <div class="edit-title">Edit Profile</div>
        <button class="btn-primary" id="btn-save-edit">Save</button>
      </div>
      <div class="edit-body">
        <div class="field-group">
          <label>Full Name</label>
          <input id="ed-name" class="text-input" value="${esc(profile.name || '')}" placeholder="Your name">
        </div>
        <div class="field-group">
          <label>Email</label>
          <input id="ed-email" type="email" class="text-input" value="${esc(profile.email || '')}" placeholder="you@example.com">
        </div>
        <div class="field-group">
          <label>Phone</label>
          <input id="ed-phone" class="text-input" value="${esc(profile.phone || '')}" placeholder="+91 ...">
        </div>
        <div class="field-group">
          <label>LinkedIn URL</label>
          <input id="ed-linkedin" class="text-input" value="${esc(profile.linkedinUrl || '')}" placeholder="linkedin.com/in/you">
        </div>
        <div class="field-group">
          <label>Target Roles</label>
          <div class="tag-wrap" id="ed-roles-wrap">
            ${editData.targetRoles.map(r => `<span class="tag-pill">${esc(r)}<span class="tag-x" data-val="${esc(r)}">×</span></span>`).join('')}
            <input id="ed-roles-input" class="tag-input" placeholder="Add role, press Enter">
          </div>
        </div>
        <div class="field-group">
          <label>Locations</label>
          <div class="tag-wrap" id="ed-locations-wrap">
            ${editData.locations.map(l => `<span class="tag-pill">${esc(l)}<span class="tag-x" data-val="${esc(l)}">×</span></span>`).join('')}
            <input id="ed-locations-input" class="tag-input" placeholder="Add location, press Enter">
          </div>
        </div>
        <div class="field-group">
          <label>Watchlist Companies</label>
          <div class="tag-wrap" id="ed-companies-wrap">
            ${editData.watchlistCompanies.map(c => `<span class="tag-pill">${esc(c)}<span class="tag-x" data-val="${esc(c)}">×</span></span>`).join('')}
            <input id="ed-companies-input" class="tag-input" placeholder="Add company, press Enter">
          </div>
        </div>
        <div class="field-group">
          <label>Experience Level</label>
          <div class="radio-pills">
            ${(['fresher','1-3','3-7','7+'] as const).map(v => `
              <button class="radio-pill ${profile.experienceLevel === v ? 'active' : ''}" data-val="${v}">${v}</button>
            `).join('')}
          </div>
        </div>
        <div class="field-group">
          <label>Alert Mode</label>
          <div class="alert-cards">
            ${(['instant','daily','weekly'] as const).map(v => `
              <div class="alert-card ${profile.alertMode === v ? 'active' : ''}" data-alert="${v}">
                <div class="ac-title">${v.charAt(0).toUpperCase() + v.slice(1)}</div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="field-group toggle-row">
          <label>Email Alerts</label>
          <div class="toggle ${profile.emailAlerts ? 'on' : ''}" id="ed-email-toggle"></div>
        </div>
      </div>
    </div>
  `);

  // Wire tag inputs
  setupEditTagInput('ed-roles-wrap', 'ed-roles-input', editData.targetRoles);
  setupEditTagInput('ed-locations-wrap', 'ed-locations-input', editData.locations);
  setupEditTagInput('ed-companies-wrap', 'ed-companies-input', editData.watchlistCompanies);

  // Experience pills
  document.querySelectorAll('.radio-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.radio-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      editData.experienceLevel = (pill as HTMLElement).dataset.val as any;
    });
  });

  // Alert cards
  document.querySelectorAll('.alert-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.alert-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      editData.alertMode = (card as HTMLElement).dataset.alert as any;
    });
  });

  // Email toggle
  document.getElementById('ed-email-toggle')?.addEventListener('click', () => {
    editData.emailAlerts = !editData.emailAlerts;
    document.getElementById('ed-email-toggle')?.classList.toggle('on', editData.emailAlerts);
  });

  // Cancel
  document.getElementById('btn-cancel-edit')?.addEventListener('click', async () => {
    const p = await profileStorage.getValue();
    if (p) await showDashboard(p);
  });

  // Save
  document.getElementById('btn-save-edit')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('btn-save-edit') as HTMLButtonElement;
    saveBtn.textContent = 'Saving…';
    saveBtn.disabled = true;

    editData.name = (document.getElementById('ed-name') as HTMLInputElement).value;
    editData.email = (document.getElementById('ed-email') as HTMLInputElement).value;
    editData.phone = (document.getElementById('ed-phone') as HTMLInputElement).value;
    editData.linkedinUrl = (document.getElementById('ed-linkedin') as HTMLInputElement).value;

    const updated: UserProfile = {
      ...profile,
      ...editData,
      updatedAt: Date.now(),
    };

    await profileStorage.setValue(updated);
    const userId = await userIdStorage.getValue();
    if (userId) {
      fetch(`${API_BASE}/api/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify(updated),
      }).catch(() => {});
    }
    browser.runtime.sendMessage({ type: 'PREFS_UPDATED', changes: updated }).catch(() => {});
    await showDashboard(updated);
  });
}

function setupEditTagInput(wrapId: string, inputId: string, arr: string[]) {
  const wrap = document.getElementById(wrapId)!;
  const input = document.getElementById(inputId) as HTMLInputElement;

  const renderTags = () => {
    wrap.querySelectorAll('.tag-pill').forEach(e => e.remove());
    arr.forEach(val => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.innerHTML = `${esc(val)}<span class="tag-x">×</span>`;
      pill.querySelector('.tag-x')!.addEventListener('click', () => {
        arr.splice(arr.indexOf(val), 1);
        renderTags();
      });
      wrap.insertBefore(pill, input);
    });
    // Remove static pills (from initial HTML)
    wrap.querySelectorAll('[data-val]').forEach(e => e.remove());
  };

  // Wire existing x buttons from static HTML
  wrap.querySelectorAll('.tag-x[data-val]').forEach(x => {
    x.addEventListener('click', () => {
      const val = (x as HTMLElement).dataset.val!;
      arr.splice(arr.indexOf(val), 1);
      renderTags();
    });
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const clean = input.value.trim();
      if (clean && !arr.includes(clean)) { arr.push(clean); renderTags(); }
      input.value = '';
    }
  });

  wrap.addEventListener('click', () => input.focus());
}

// ────────────────────────────────────────────────────────
// WIZARD VIEW
// ────────────────────────────────────────────────────────
function showWizard() {
  currentView = 'wizard';
  // Inject the wizard HTML (keep original index.html structure visible)
  const wizardEl = document.getElementById('wizard-root');
  const dashEl = document.getElementById('dynamic-root');
  if (dashEl) dashEl.style.display = 'none';
  if (wizardEl) {
    wizardEl.style.display = '';
    initWizard();
  }
}

function initWizard() {
  renderStepDots();
  updateStepVisibility();
  setupTagInputs();
  setupRadioPills();
  setupAlertCards();

  document.getElementById('btn-next')?.addEventListener('click', handleNext);
  document.getElementById('btn-back')?.addEventListener('click', handleBack);
  document.getElementById('btn-launch')?.addEventListener('click', handleLaunch);
  document.getElementById('skip-companies')?.addEventListener('click', handleNext);

  document.getElementById('toggle-email')?.addEventListener('click', () => {
    profileData.emailAlerts = !profileData.emailAlerts;
    document.getElementById('toggle-email')?.classList.toggle('on', !!profileData.emailAlerts);
  });

  document.getElementById('ob-email')?.addEventListener('input', (e) => {
    const val = (e.target as HTMLInputElement).value;
    profileData.email = val;
    const row = document.getElementById('email-toggle-row');
    if (row) row.style.display = val.includes('@') ? 'flex' : 'none';
  });
}

function renderStepDots() {
  const indicator = document.getElementById('step-indicator');
  if (!indicator) return;
  indicator.innerHTML = '';
  for (let i = 1; i <= totalSteps; i++) {
    const dot = document.createElement('div');
    dot.className = `step-dot ${i === currentStep ? 'active' : ''} ${i < currentStep ? 'done' : ''}`;
    indicator.appendChild(dot);
    if (i < totalSteps) {
      const line = document.createElement('div');
      line.className = `step-line ${i < currentStep ? 'done' : ''}`;
      indicator.appendChild(line);
    }
  }
}

function updateStepVisibility() {
  document.querySelectorAll('.step-panel').forEach(p => {
    const step = parseInt(p.getAttribute('data-step') || '1', 10);
    p.classList.toggle('visible', step === currentStep);
  });
  const stepCard = document.getElementById('step-card');
  if (stepCard) stepCard.style.setProperty('--progress', `${((currentStep - 1) / (totalSteps - 1)) * 100}%`);

  const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
  if (btnBack) btnBack.style.display = currentStep > 1 ? 'block' : 'none';

  const navButtons = document.getElementById('nav-buttons');
  if (currentStep === totalSteps) {
    if (navButtons) navButtons.style.display = 'none';
    populateSummary();
  } else {
    if (navButtons) navButtons.style.display = 'flex';
  }
  renderStepDots();
  validateCurrentStep();
}

function handleNext() {
  if (currentStep < totalSteps) {
    saveCurrentStepData();
    currentStep++;
    updateStepVisibility();
  }
}

function handleBack() {
  if (currentStep > 1) { currentStep--; updateStepVisibility(); }
}

function validateCurrentStep() {
  const btnNext = document.getElementById('btn-next') as HTMLButtonElement;
  if (btnNext) btnNext.disabled = currentStep === 2 && profileData.targetRoles.length === 0;
}

function saveCurrentStepData() {
  if (currentStep === 1) {
    profileData.name = (document.getElementById('ob-name') as HTMLInputElement)?.value || '';
    profileData.phone = (document.getElementById('ob-phone') as HTMLInputElement)?.value || '';
    profileData.linkedinUrl = (document.getElementById('ob-linkedin') as HTMLInputElement)?.value || '';
  }
}

function populateSummary() {
  const grid = document.getElementById('summary-grid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="summary-item"><div class="si-number">${profileData.targetRoles.length}</div><div class="si-label">Roles tracked</div></div>
    <div class="summary-item"><div class="si-number">${profileData.locations.length || 'All'}</div><div class="si-label">Locations</div></div>
    <div class="summary-item"><div class="si-number">${profileData.watchlistCompanies.length}</div><div class="si-label">Companies</div></div>
    <div class="summary-item"><div class="si-number" style="font-size:18px;margin-top:10px">${profileData.alertMode}</div><div class="si-label">Alert Mode</div></div>
  `;
}

function setupTagInputs() {
  const configs = [
    { id: 'roles', arr: profileData.targetRoles },
    { id: 'locations', arr: profileData.locations },
    { id: 'companies', arr: profileData.watchlistCompanies },
  ];
  configs.forEach(({ id, arr }) => {
    const wrap = document.getElementById(`${id}-wrap`);
    const input = document.getElementById(`${id}-input`) as HTMLInputElement;
    const suggs = document.querySelectorAll(`#${id}-suggestions .suggestion-chip`);
    if (!wrap || !input) return;

    const renderTags = () => {
      wrap.querySelectorAll('.tag-pill').forEach(e => e.remove());
      arr.forEach(val => {
        const pill = document.createElement('div');
        pill.className = 'tag-pill';
        pill.innerHTML = `<span>${val}</span><span class="tag-x">×</span>`;
        pill.querySelector('.tag-x')!.addEventListener('click', () => {
          arr.splice(arr.indexOf(val), 1);
          renderTags(); validateCurrentStep();
        });
        wrap.insertBefore(pill, input);
      });
      suggs.forEach(s => s.classList.toggle('selected', arr.includes(s.getAttribute('data-val')!)));
    };

    const addTag = (val: string) => {
      const clean = val.trim();
      if (clean && !arr.includes(clean)) { arr.push(clean); renderTags(); validateCurrentStep(); }
      input.value = '';
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(input.value); }
    });
    suggs.forEach(s => s.addEventListener('click', () => addTag(s.getAttribute('data-val')!)));
    wrap.addEventListener('click', () => input.focus());
  });
}

function setupRadioPills() {
  document.querySelectorAll('.radio-pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('.radio-pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      profileData.experienceLevel = (p as HTMLElement).getAttribute('data-val') as any || 'fresher';
    });
  });
}

function setupAlertCards() {
  document.querySelectorAll('.radio-card').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('.radio-card').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      profileData.alertMode = (c as HTMLElement).getAttribute('data-alert') as any || 'instant';
    });
  });
}

async function handleLaunch() {
  const btn = document.getElementById('btn-launch') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    let userId = await userIdStorage.getValue();
    if (!userId) { userId = crypto.randomUUID(); await userIdStorage.setValue(userId); }

    const now = Date.now();
    const profileToSave: UserProfile = {
      name: profileData.name || '',
      phone: profileData.phone || '',
      email: profileData.email || '',
      linkedinUrl: profileData.linkedinUrl || '',
      targetRoles: profileData.targetRoles,
      locations: profileData.locations,
      watchlistCompanies: profileData.watchlistCompanies,
      experienceLevel: profileData.experienceLevel || 'fresher',
      alertMode: profileData.alertMode as any || 'instant',
      emailAlerts: !!profileData.emailAlerts,
      isOnboarded: true,
      createdAt: now,
      updatedAt: now,
    };

    await profileStorage.setValue(profileToSave);
    await monitorStateStorage.setValue({ active: true, lastPollAt: null, lastCycleMatchCount: 0, totalJobsFound: 0, totalAlertsCount: 0 });

    await fetch(`${API_BASE}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
      body: JSON.stringify(profileToSave),
    }).catch(() => {});

    await browser.runtime.sendMessage({ type: 'START_MONITOR', profile: profileToSave });

    const currTab = await browser.tabs.getCurrent();
    if (currTab?.id) browser.tabs.remove(currTab.id);
    else window.close();
  } catch (err) {
    console.error(err);
    btn.disabled = false; btn.textContent = 'Try again';
  }
}

// ────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────
function setRoot(html: string) {
  let root = document.getElementById('dynamic-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'dynamic-root';
    document.body.appendChild(root);
  }
  root.style.display = '';
  root.innerHTML = html;

  const wizardEl = document.getElementById('wizard-root');
  if (wizardEl && currentView !== 'wizard') wizardEl.style.display = 'none';
}

function getInitials(name: string): string {
  const parts = (name || '?').trim().split(' ').filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function esc(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Boot
mount();
