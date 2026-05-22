import { browser } from 'wxt/browser';
import { trackedPagesStorage, isCareerPage, normalizeCareerUrl, TrackedPage } from '../lib/storage';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    let pillButton: HTMLElement | null = null;
    let hudPanel: HTMLElement | null = null;
    let currentPillState: 'available' | 'loading' | 'tracking' | 'tracking-new' | 'error' = 'available';
    let isTracked = false;
    let newCount = 0;
    const currentUrl = window.location.href;

    // ──────────────────────────────────────────────────
    // SHADOW DOM HOST
    // ──────────────────────────────────────────────────
    function createShadowHost(): { host: HTMLElement; shadow: ShadowRoot } {
      const host = document.createElement('div');
      host.id = 'nextrole-root';
      host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646; pointer-events: none; top: 0; left: 0; width: 0; height: 0;';
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });

      const styles = document.createElement('style');
      styles.textContent = getStyles();
      shadow.appendChild(styles);

      ctx.onInvalidated(() => host.remove());

      return { host, shadow };
    }

    function getStyles(): string {
      return `
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;700&family=Syne:wght@700;800&display=swap');

        :host { all: initial; font-family: 'IBM Plex Mono', monospace; }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        /* ── Floating Pill ── */
        .pill-btn {
          position: fixed; bottom: 20px; right: 20px; display: flex; align-items: center; gap: 8px;
          padding: 8px 16px; height: 40px; background: #fff;
          border: 3px solid #000; color: #000;
          font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 700;
          cursor: pointer; pointer-events: auto; transition: transform 0.15s;
          box-shadow: 4px 4px 0px #000; z-index: 2147483646; user-select: none;
        }
        .pill-btn:hover { transform: translate(-2px, -2px); box-shadow: 6px 6px 0px #000; }
        .pill-btn:active { transform: translate(2px, 2px); box-shadow: 2px 2px 0px #000; }

        .pill-btn.nr-pill--tracking { background: #2ecc71; }
        .pill-btn.nr-pill--tracking .pill-icon { color: #000; }
        
        .pill-btn.nr-pill--tracking-new { background: #ff6b81; color: #fff; animation: popAlert 2s infinite; }
        .pill-btn.nr-pill--tracking-new .pill-icon { color: #fff; }

        .pill-btn.nr-pill--loading { background: #f1c40f; cursor: wait; }
        .pill-btn.nr-pill--error { background: #e74c3c; color: #fff; }
        .pill-btn.nr-pill--error .pill-icon { color: #fff; }

        @keyframes popAlert {
          0%, 100% { box-shadow: 4px 4px 0px #000; }
          50% { box-shadow: 8px 8px 0px #000; transform: translate(-4px, -4px); }
        }

        .pill-icon { width: 16px; height: 16px; color: #000; flex-shrink: 0; }

        .pulse-dot {
          width: 8px; height: 8px; border: 2px solid #000; background: #fff;
          animation: blink 1s step-end infinite; flex-shrink: 0;
        }
        @keyframes blink { 50% { opacity: 0; } }

        .spinner-small {
          width: 16px; height: 16px; border: 3px solid #000;
          border-top-color: #fff; border-radius: 50%;
          animation: spin 0.7s linear infinite; flex-shrink: 0;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── Toast ── */
        .nr-toast {
          position: fixed; bottom: 80px; right: 20px;
          background: #2ecc71; border: 3px solid #000;
          color: #000; font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 800; text-transform: uppercase;
          padding: 10px 20px; box-shadow: 4px 4px 0px #000; pointer-events: auto;
          transform: translateY(20px); opacity: 0;
          transition: all 0.2s cubic-bezier(0.34,1.56,0.64,1);
          z-index: 2147483646;
        }
        .nr-toast.show { opacity: 1; transform: translateY(0); }

        /* ── HUD Panel ── */
        .hud-panel {
          position: fixed; top: 0; right: -320px;
          width: 300px; height: 100vh; background: #F4F4F0;
          border-left: 3px solid #000; display: flex; flex-direction: column;
          pointer-events: auto; transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          z-index: 2147483645; font-family: 'IBM Plex Mono', monospace; color: #000;
          box-shadow: -4px 0 0px rgba(0,0,0,0.1);
        }
        .hud-panel.open { right: 0; box-shadow: -8px 0 0px #000; }

        .hud-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px; border-bottom: 3px solid #000; flex-shrink: 0; background: #fff;
        }
        .hud-title {
          font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 800; color: #000; letter-spacing: 1px; text-transform: uppercase;
        }
        .hud-close {
          background: #f1c40f; border: 2px solid #000; color: #000; cursor: pointer; font-size: 16px; font-weight: 800;
          padding: 2px 8px; box-shadow: 2px 2px 0 #000; pointer-events: auto; transition: transform 0.1s;
        }
        .hud-close:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000; background: #e74c3c; color: #fff; }

        .hud-body { flex: 1; overflow-y: auto; padding: 16px; }
        .hud-body::-webkit-scrollbar { width: 6px; }
        .hud-body::-webkit-scrollbar-thumb { background: #4A90E2; border: 2px solid #000; }

        .hud-empty { text-align: center; background: #fff; border: 2px solid #000; box-shadow: 4px 4px 0 #000; color: #000; font-size: 12px; font-weight: 700; padding: 32px 16px; line-height: 1.6; margin-top: 20px; }
        .hud-new-pill { text-align: center; margin-bottom: 16px; font-size: 11px; font-weight: 800; color: #fff; background: #ff6b81; border: 2px solid #000; box-shadow: 2px 2px 0 #000; padding: 6px; text-transform: uppercase; }

        .hud-job { padding: 12px; border: 2px solid #000; background: #fff; box-shadow: 3px 3px 0 #000; margin-bottom: 12px; cursor: pointer; transition: transform 0.15s; animation: popIn 0.2s ease-out; }
        @keyframes popIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        .hud-job:hover { transform: translate(-2px, -2px); box-shadow: 5px 5px 0 #000; background: #e0f7fa; }
        
        .hud-job-title { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800; color: #000; margin-bottom: 6px; line-height: 1.3; text-transform: uppercase; }
        .hud-job-meta { font-size: 11px; font-weight: 700; color: #444; display: flex; align-items: center; gap: 6px; }
        .hud-new-badge { font-size: 10px; font-weight: 800; padding: 2px 6px; background: #ff6b81; color: #fff; border: 2px solid #000; }
        .hud-match-bar { width: 100%; height: 6px; background: #fff; border: 2px solid #000; margin-top: 10px; }
        .hud-match-fill { height: 100%; background: #4A90E2; border-right: 2px solid #000; }
      `;
    }

    const RADAR_SVG = `<svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49M7.76 16.24a6 6 0 010-8.49"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 19.07a10 10 0 010-14.14"/></svg>`;

    function setPillState(state: typeof currentPillState, count = 0) {
      if (!pillButton) return;
      currentPillState = state;
      pillButton.className = `pill-btn nr-pill--${state}`;

      if (state === 'available') {
        pillButton.innerHTML = `${RADAR_SVG}<span>Track this page</span>`;
      } else if (state === 'loading') {
        pillButton.innerHTML = '<div class="spinner-small"></div><span>Adding…</span>';
      } else if (state === 'tracking') {
        pillButton.innerHTML = `<div class="pulse-dot"></div><span>Tracking${count > 0 ? ` · ${count} new` : ''}</span>`;
      } else if (state === 'tracking-new') {
        pillButton.innerHTML = `<div class="pulse-dot"></div><span>Tracking · ${count} new</span>`;
      } else if (state === 'error') {
        pillButton.innerHTML = `${RADAR_SVG}<span>Error — retry?</span>`;
      }
    }

    function renderPill(shadow: ShadowRoot) {
      if (!pillButton) {
        pillButton = document.createElement('div');
        pillButton.addEventListener('click', () => handlePillClick(shadow));
        shadow.appendChild(pillButton);
      }
      setPillState(isTracked ? (newCount > 0 ? 'tracking-new' : 'tracking') : 'available', newCount);
    }

    async function handlePillClick(shadow: ShadowRoot) {
      if (currentPillState.startsWith('tracking')) {
        hudPanel?.classList.toggle('open');
        if (hudPanel?.classList.contains('open') && currentPillState === 'tracking-new') {
          setPillState('tracking', newCount); // Downgrade state
        }
        return;
      }

      setPillState('loading');
      try {
        const res = await browser.runtime.sendMessage({ type: 'ADD_TRACKED_SEARCH', url: window.location.href });
        if (res.error) throw new Error(res.error);
        showToast(shadow, '✓ Page added to NextRole watchlist');
        // Watcher will update state to tracking automatically
      } catch {
        setPillState('error');
        setTimeout(() => { if (currentPillState === 'error') setPillState('available'); }, 3000);
        showToast(shadow, '⚠ Failed to add — try again');
      }
    }

    function showToast(shadow: ShadowRoot, msg: string) {
      let existing = shadow.querySelector('.nr-toast') as HTMLElement;
      if (existing) existing.remove();
      const t = document.createElement('div');
      t.className = 'nr-toast';
      t.textContent = msg;
      shadow.appendChild(t);
      requestAnimationFrame(() => {
        t.classList.add('show');
        setTimeout(() => {
          t.classList.remove('show');
          setTimeout(() => t.remove(), 200);
        }, 2800);
      });
    }

    function renderHudPanel(shadow: ShadowRoot, jobs: any[] = [], isDelta = false) {
      if (!hudPanel) {
        let companyName = '';
        try {
          const host = new URL(window.location.href).hostname.replace('www.', '');
          companyName = host.split('.')[0];
          companyName = companyName.charAt(0).toUpperCase() + companyName.slice(1);
        } catch {}

        hudPanel = document.createElement('div');
        hudPanel.className = 'hud-panel';
        hudPanel.innerHTML = `
          <div class="hud-header">
            <div class="hud-title">NEXTROLE · ${companyName}</div>
            <button class="hud-close">&times;</button>
          </div>
          <div class="hud-body"></div>
        `;
        shadow.appendChild(hudPanel);
        hudPanel.querySelector('.hud-close')!.addEventListener('click', () => hudPanel?.classList.remove('open'));
      }

      const body = hudPanel.querySelector('.hud-body')!;
      
      if (jobs.length === 0 && !isDelta) {
        body.innerHTML = '<div class="hud-empty">No matched jobs yet.<br/>We\'ll notify you when they appear.</div>';
        return;
      }

      // Remove empty state if present
      body.querySelector('.hud-empty')?.remove();

      if (isDelta) {
        const pill = document.createElement('div');
        pill.className = 'hud-new-pill';
        pill.textContent = `${jobs.length} new match${jobs.length !== 1 ? 'es' : ''}`;
        body.prepend(pill);
      }

      const jobsHtml = jobs.map(j => `
        <div class="hud-job" data-url="${j.url || ''}">
          <div class="hud-job-title">${j.title || 'Untitled'}</div>
          <div class="hud-job-meta">
            <span>${j.location || ''}</span>
            ${!j.seenAt ? '<span class="hud-new-badge">NEW</span>' : ''}
          </div>
          <div class="hud-match-bar"><div class="hud-match-fill" style="width: 75%"></div></div>
        </div>
      `).join('');

      if (isDelta) {
        body.insertAdjacentHTML('afterbegin', jobsHtml);
      } else {
        body.innerHTML = jobsHtml;
      }

      // Re-attach click listeners for newly added jobs
      body.querySelectorAll('.hud-job:not(.bound)').forEach(el => {
        el.classList.add('bound');
        el.addEventListener('click', () => {
          const url = (el as HTMLElement).getAttribute('data-url');
          if (url) window.open(url, '_blank');
        });
      });
    }

    // ──────────────────────────────────────────────────
    // INIT & SYNC
    // ──────────────────────────────────────────────────
    async function boot() {
      if (!isCareerPage(window.location.href, document)) return;

      document.getElementById('nextrole-root')?.remove();
      const { host, shadow } = createShadowHost();

      // Read initial tracking state
      const pages = await trackedPagesStorage.getValue() ?? [];
      const currentUrlNorm = normalizeCareerUrl(window.location.href);
      const page = pages.find(p => p.normalizedUrl === currentUrlNorm);
      
      isTracked = !!page;
      newCount = page?.newJobCount || 0;
      
      renderPill(shadow);
      renderHudPanel(shadow); // empty initially until jobs load

      // Watch for storage changes (e.g. from popup or background)
      trackedPagesStorage.watch(newPages => {
        if (!newPages) return;
        const p = newPages.find(p => p.normalizedUrl === currentUrlNorm);
        isTracked = !!p;
        newCount = p?.newJobCount || 0;
        setPillState(isTracked ? (newCount > 0 ? 'tracking-new' : 'tracking') : 'available', newCount);
      });

      // Listen for NEW_JOBS messages directly from background for instant animation
      browser.runtime.onMessage.addListener((msg: any) => {
        if (msg.type === 'NEW_JOBS_FOR_PAGE' && isTracked) {
          try {
            if (normalizeCareerUrl(msg.url) === currentUrlNorm) {
              const jobs = msg.jobs || [];
              if (jobs.length > 0) {
                newCount += jobs.length;
                setPillState('tracking-new', newCount);
                renderHudPanel(shadow, jobs, true);
                
                if (!hudPanel?.classList.contains('open')) {
                  showToast(shadow, `${jobs.length} new job match${jobs.length !== 1 ? 'es' : ''} — open HUD to view`);
                }
              }
            }
          } catch {}
        }
      });
    }

    // Handle SPA navigations
    let lastUrl = window.location.href;
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        boot();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    ctx.onInvalidated(() => observer.disconnect());

    boot();
  },
});
