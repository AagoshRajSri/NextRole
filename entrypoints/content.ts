import { browser } from 'wxt/browser';
import {
  trackedPagesStorage,
  unseenJobsStorage,
  profileStorage,
  isCareerPage,
  normalizeCareerUrl,
  StoredJob,
} from '../lib/storage';
import { detectPlatform } from '../lib/utils';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    let pillButton: HTMLElement | null = null;
    let hudPanel: HTMLElement | null = null;
    let hudBody: HTMLElement | null = null;
    let hudFooter: HTMLElement | null = null;
    
    let hudRoot: HTMLElement | null = null;
    let pillRoot: HTMLElement | null = null;
    let hudShadow: ShadowRoot | null = null;
    let pillShadow: ShadowRoot | null = null;

    let currentPillState: 'available' | 'loading' | 'tracking' | 'tracking-new' | 'error' = 'available';
    let isTracked = false;
    let cachedJobs: StoredJob[] = [];
    let lastScanTime = 0;
    let lastScanPlatform = '';
    
    let isScanInProgress = false;
    let lastScannedUrl = '';
    let scanDebounceTimer: NodeJS.Timeout;

    // ──────────────────────────────────────────────────
    // FIX 1.1: LOGIN OR AUTH PAGE GUARD
    // ──────────────────────────────────────────────────
    
    function interceptSPANavigation() {
      const originalPushState = history.pushState.bind(history)
      const originalReplaceState = history.replaceState.bind(history)
      
      history.pushState = function(...args) {
        originalPushState(...args)
        handleUrlChange()
      }
      
      history.replaceState = function(...args) {
        originalReplaceState(...args)
        handleUrlChange()
      }
      
      window.addEventListener('popstate', handleUrlChange)
    }

    let urlChangeTimer;
    let lastHandledUrl = '';

    function handleUrlChange() {
      const currentUrl = window.location.href
      if (currentUrl === lastHandledUrl) return
      if (isLoginOrAuthPage(currentUrl)) { removePillIfExists(); return }
      
      clearTimeout(urlChangeTimer)
      urlChangeTimer = setTimeout(() => {
        lastHandledUrl = currentUrl
        if (isCareerPage(currentUrl, document)) {
          updatePillForCurrentPage()
          runPageScanWithRetry()
        } else {
          removePillIfExists()
        }
      }, 800)
    }
    
    function isLoginOrAuthPage(url: string): boolean {
      const path = new URL(url).pathname.toLowerCase();
      return path.includes('/login') ||
             path.includes('/authwall') ||
             path.includes('/checkpoint') ||
             path.includes('/signup') ||
             path.includes('/uas/login') ||
             path.includes('/join');
    }

    function removePillIfExists() {
      if (pillRoot) pillRoot.remove();
      if (hudRoot) hudRoot.remove();
      pillRoot = null;
      hudRoot = null;
    }

    // ──────────────────────────────────────────────────
    // SHADOW DOM HOSTS
    // ──────────────────────────────────────────────────
    function createHudShadow(): { host: HTMLElement; shadow: ShadowRoot } {
      const host = document.createElement('div');
      host.id = 'nextrole-hud-root';
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483645;pointer-events:none;top:0;left:0;width:0;height:0;';
      document.body.appendChild(host);
      const sh = host.attachShadow({ mode: 'open' });
      const styles = document.createElement('style');
      styles.textContent = getHudStyles();
      sh.appendChild(styles);
      ctx.onInvalidated(() => host.remove());
      return { host, shadow: sh };
    }

    function createPillShadow(): { host: HTMLElement; shadow: ShadowRoot } {
      const host = document.createElement('div');
      host.id = 'nextrole-pill-root';
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;pointer-events:none;top:0;left:0;width:0;height:0;';
      document.body.appendChild(host);
      const sh = host.attachShadow({ mode: 'open' });
      const styles = document.createElement('style');
      styles.textContent = getPillStyles();
      sh.appendChild(styles);
      ctx.onInvalidated(() => host.remove());
      return { host, shadow: sh };
    }

    function getPillStyles(): string {
      return `
        :host { all: initial; font-family: system-ui, sans-serif; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .pill-btn {
          position: fixed; bottom: 20px; right: 20px; display: flex; align-items: center; gap: 8px;
          padding: 8px 16px; height: 40px; background: #fff;
          border: 3px solid #000; color: #000;
          font-family: system-ui, sans-serif; font-size: 13px; font-weight: 700;
          cursor: pointer; pointer-events: auto; transition: transform 0.15s;
          box-shadow: 4px 4px 0px #000; user-select: none;
        }
        .pill-btn:hover { transform: translate(-2px,-2px); box-shadow: 6px 6px 0px #000; }
        .pill-btn:active { transform: translate(2px,2px); box-shadow: 2px 2px 0px #000; }
        .pill-btn.nr-pill--tracking { background: #2ecc71; }
        .pill-btn.nr-pill--tracking-new { background: #00E5FF; color:#000; animation: popAlert 2s infinite; }
        .pill-btn.nr-pill--loading { background: #f1c40f; cursor:wait; }
        .pill-btn.nr-pill--error { background: #e74c3c; color:#fff; }
        @keyframes popAlert {
          0%,100% { box-shadow:4px 4px 0 #000; }
          50% { box-shadow:8px 8px 0 #000; transform:translate(-4px,-4px); }
        }
        .pulse-dot { width:8px;height:8px;border:2px solid #000;background:#fff;animation:blink 1s step-end infinite;flex-shrink:0; }
        @keyframes blink { 50%{opacity:0;} }
        .spinner-small { width:16px;height:16px;border:3px solid #000;border-top-color:transparent;border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0; }
        @keyframes spin { to{transform:rotate(360deg);} }
      `;
    }

    function getHudStyles(): string {
      return `
        :host { all: initial; font-family: system-ui, sans-serif; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .hud-panel {
          position:fixed;top:0;right:-320px;width:300px;height:100vh;background:#F4F4F0;
          border-left:3px solid #000;display:flex;flex-direction:column;
          pointer-events:auto;transition:right 0.3s cubic-bezier(0.4,0,0.2,1);
          color:#000;
        }
        .hud-panel.open { right:0;box-shadow:-8px 0 0 #000; }
        .hud-header {
          display:flex;align-items:center;justify-content:space-between;
          padding:16px;border-bottom:3px solid #000;flex-shrink:0;background:#fff;
        }
        .hud-title { font-size:13px;font-weight:900;color:#000;letter-spacing:1px;text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
        .hud-close {
          background:#f1c40f;border:2px solid #000;color:#000;cursor:pointer;
          font-size:16px;font-weight:800;padding:2px 8px;box-shadow:2px 2px 0 #000;
          pointer-events:auto;transition:transform 0.1s;
        }
        .hud-close:hover { transform:translate(-1px,-1px);box-shadow:3px 3px 0 #000;background:#e74c3c;color:#fff; }
        .hud-body { flex:1;overflow-y:auto;padding:12px; }
        .hud-body::-webkit-scrollbar { width:5px; }
        .hud-body::-webkit-scrollbar-thumb { background:#4A90E2;border:1px solid #000; }
        .hud-footer {
          padding: 8px 12px; border-top: 2px solid #000; background: #fff;
          font-size: 10px; font-weight: 700; color: #555; text-transform: uppercase;
        }
        .hud-state {
          text-align:center;padding:24px 16px;border:2px solid #000;background:#fff;
          box-shadow:4px 4px 0 #000;margin-top:8px;
        }
        .hud-state h3 { font-size:14px;font-weight:800;margin-bottom:8px;text-transform:uppercase; }
        .hud-state p { font-size:11px;color:#555;margin-bottom:16px;line-height:1.5; }
        .btn-primary {
          background:#4A90E2;color:#fff;border:2px solid #000;box-shadow:2px 2px 0 #000;
          padding:10px;width:100%;font-weight:800;cursor:pointer;
          font-family:inherit;font-size:12px;text-transform:uppercase;
          transition:transform 0.1s,box-shadow 0.1s; margin-top: 8px;
        }
        .btn-primary:hover { transform:translate(-1px,-1px);box-shadow:4px 4px 0 #000; }
        .btn-primary:active { transform:translate(1px,1px);box-shadow:0 0 0 #000; }
        .hud-job {
          padding:10px;border:2px solid #000;background:#fff;box-shadow:3px 3px 0 #000;
          margin-bottom:10px;cursor:pointer;transition:transform 0.15s;
          animation:popIn 0.2s ease-out; border-left: 4px solid #00E5FF;
        }
        @keyframes popIn { from{opacity:0;transform:scale(0.95);}to{opacity:1;transform:scale(1);} }
        .hud-job:hover { transform:translate(-2px,-2px);box-shadow:5px 5px 0 #000;background:#e0f7fa; }
        .hud-job-title { font-size:13px;font-weight:800;color:#000;margin-bottom:4px;line-height:1.3;text-transform:uppercase; }
        .hud-job-reason { font-size:10px;font-weight:700;color:#00bcd4;margin-bottom:4px; text-transform:uppercase;}
        .hud-job-meta { font-size:10px;font-weight:600;color:#555;display:flex;align-items:center;gap:6px;flex-wrap:wrap; }
        .badge-new { font-size:9px;font-weight:800;padding:2px 5px;background:#00E5FF;color:#000;border:1px solid #000; }
      `;
    }

    const RADAR_SVG = `<svg style="width:16px;height:16px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49M7.76 16.24a6 6 0 010-8.49"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 19.07a10 10 0 010-14.14"/></svg>`;

    // ──────────────────────────────────────────────────
    // PILL STATE
    // ──────────────────────────────────────────────────
    function setPillState(state: typeof currentPillState, count = 0) {
      if (!pillButton) return;
      currentPillState = state;
      pillButton.className = `pill-btn nr-pill--${state}`;
      if (state === 'available') pillButton.innerHTML = `${RADAR_SVG}<span>+ Track this page</span>`;
      else if (state === 'loading') pillButton.innerHTML = `<div class="spinner-small"></div><span>Scanning…</span>`;
      else if (state === 'tracking') pillButton.innerHTML = `<div class="pulse-dot"></div><span>Tracking</span>`;
      else if (state === 'tracking-new') pillButton.innerHTML = `<div class="pulse-dot"></div><span>Tracking · ${count} new</span>`;
      else if (state === 'error') pillButton.innerHTML = `${RADAR_SVG}<span>Scan Error</span>`;
    }

    // ──────────────────────────────────────────────────
    // RICH TOAST
    // ──────────────────────────────────────────────────
    function showRichToast({ type, title, body, duration }: { type: 'success'|'info'|'error', title: string, body: string, duration: number }) {
      const existing = document.getElementById('nr-toast-container');
      if (existing) existing.remove();

      const container = document.createElement('div');
      container.id = 'nr-toast-container';
      container.style.position = 'fixed';
      container.style.bottom = '80px';
      container.style.left = '50%';
      container.style.transform = 'translateX(-50%)';
      container.style.zIndex = '2147483647';
      container.style.fontFamily = "'IBM Plex Mono', monospace";

      const toast = document.createElement('div');
      const color = type === 'success' ? '#00FF88' : type === 'error' ? '#e74c3c' : '#00E5FF';
      toast.style.background = 'rgba(10,21,37,0.95)';
      toast.style.border = '1px solid ' + color;
      toast.style.borderRadius = '10px';
      toast.style.padding = '12px 18px';
      toast.style.minWidth = '280px';
      toast.style.maxWidth = '380px';
      toast.style.boxShadow = '0 8px 32px rgba(0,0,0,0.4)';

      const titleEl = document.createElement('div');
      titleEl.style.fontSize = '12px';
      titleEl.style.fontWeight = '500';
      titleEl.style.color = color;
      titleEl.style.marginBottom = '4px';
      titleEl.textContent = title;

      const bodyEl = document.createElement('div');
      bodyEl.style.fontSize = '11px';
      bodyEl.style.color = '#8AA4C0';
      bodyEl.textContent = body;

      toast.appendChild(titleEl);
      toast.appendChild(bodyEl);
      container.appendChild(toast);
      document.body.appendChild(container);

      container.animate([
        { opacity: 0, transform: 'translateX(-50%) translateY(12px)' },
        { opacity: 1, transform: 'translateX(-50%) translateY(0)' }
      ], { duration: 250, easing: 'cubic-bezier(0.34,1.56,0.64,1)', fill: 'forwards' });

      setTimeout(() => {
        container.animate([{ opacity: 1 }, { opacity: 0 }],
          { duration: 150, fill: 'forwards' }
        ).onfinish = () => container.remove();
      }, duration);
    }

    // ──────────────────────────────────────────────────
    // CLIENT-SIDE SCAN
    // ──────────────────────────────────────────────────
    async function runPageScanWithRetry(maxRetries = 3, retryDelayMs = 2000) {
      if (isScanInProgress) return;
      isScanInProgress = true;
      lastScannedUrl = window.location.href;
      setPillState('loading');
      renderHudContent();

      try {
        const profile = await profileStorage.getValue();
        if (!profile?.isOnboarded) {
          setPillState(isTracked ? 'tracking' : 'available');
          return;
        }

        const platform = detectPlatform(window.location.href);

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            await new Promise(r => setTimeout(r, retryDelayMs * attempt));
          }
          
          const { scrapeCurrentPage } = await import('../lib/clientScraper');
          const result = scrapeCurrentPage(document, window.location.href);

          lastScanTime = Date.now();
          lastScanPlatform = result.platform;

          if (result.jobs.length > 0) {
            await browser.runtime.sendMessage({
              type: 'PAGE_SCAN_RESULT',
              payload: { url: window.location.href, platform: result.platform, jobs: result.jobs, scannedAt: lastScanTime }
            });
            return;
          }

          const isSpaPlatform = ['workday', 'workable', 'greenhouse'].includes(result.platform);
          if (!isSpaPlatform || attempt === maxRetries) {
            await browser.runtime.sendMessage({
              type: 'PAGE_SCAN_RESULT',
              payload: { url: window.location.href, platform: result.platform, jobs: [], scannedAt: lastScanTime }
            });
            setPillState(isTracked ? 'tracking' : 'available');
            renderHudContent();
            if (result.platform === 'linkedin' && document.querySelectorAll('.job-search-card').length === 0) {
              if (hudBody) {
                hudBody.innerHTML = `
                  <div class="hud-state">
                    <h3>No Matches</h3>
                    <p>LinkedIn shows fewer results when you're logged out. Sign into LinkedIn for full job feed access.</p>
                    <button class="btn-primary" onclick="window.open('https://www.linkedin.com/login', '_blank')">Sign in to LinkedIn</button>
                  </div>
                `;
              }
            }
            return;
          }

          console.log(`[NextRole] ${result.platform}: 0 jobs found, retrying in ${retryDelayMs * (attempt+1)}ms`);
        }
      } catch (err) {
        console.error('[NextRole] Client scan failed:', err);
        setPillState('error');
      } finally {
        isScanInProgress = false;
      }
    }

    async function trackAndScan() {
      const currentUrl = window.location.href;
      const normalized = normalizeCareerUrl(currentUrl);
      const pages = await trackedPagesStorage.getValue() ?? [];
      
      if (!pages.find(p => p.normalizedUrl === normalized)) {
        pages.push({
          id: crypto.randomUUID(),
          url: currentUrl,
          normalizedUrl: normalized,
          label: document.title || 'Career Page',
          subtitle: window.location.hostname,
          addedAt: Date.now(),
          lastScrapedAt: 0,
          lastScrapeStatus: 'pending',
          lastScrapeError: null,
          newJobCount: 0,
          isPending: false,
          platform: detectPlatform(currentUrl),
        });
        await trackedPagesStorage.setValue(pages);
      }
      isTracked = true;
      setPillState('loading');
      
      const { scrapeCurrentPage } = await import('../lib/clientScraper');
      const result = scrapeCurrentPage(document, currentUrl);
      
      if (result.jobs.length > 0) {
        // Will be updated by PAGE_SCAN_RESULT response via listener
        await browser.runtime.sendMessage({
          type: 'PAGE_SCAN_RESULT',
          payload: { url: currentUrl, platform: result.platform, jobs: result.jobs, scannedAt: Date.now() }
        });
        
        showRichToast({
          type: 'success',
          title: `Tracking · ${result.jobs.length} jobs found`,
          body: 'Matches will update shortly.',
          duration: 5000,
        });
      } else {
        setPillState('tracking', 0);
        showRichToast({
          type: 'info',
          title: 'Page added to tracking',
          body: 'NextRole will check this page every 15 minutes',
          duration: 3000,
        });
      }

      await browser.runtime.sendMessage({
        type: 'ADD_TRACKED_URL',
        payload: { url: currentUrl, platform: detectPlatform(currentUrl) }
      });
    }

    // ──────────────────────────────────────────────────
    // HUD RENDERING
    // ──────────────────────────────────────────────────
    function buildHud(companyName: string) {
      if (!hudShadow) return;
      if (hudPanel) hudPanel.remove();

      hudPanel = document.createElement('div');
      hudPanel.className = 'hud-panel';
      hudPanel.innerHTML = `
        <div class="hud-header">
          <div class="hud-title" title="NEXTROLE · ${companyName}">NEXTROLE · ${companyName}</div>
          <button class="hud-close">&times;</button>
        </div>
        <div class="hud-body"></div>
        <div class="hud-footer"></div>
      `;
      hudShadow.appendChild(hudPanel);
      hudBody = hudPanel.querySelector('.hud-body');
      hudFooter = hudPanel.querySelector('.hud-footer');
      hudPanel.querySelector('.hud-close')!.addEventListener('click', () => hudPanel?.classList.remove('open'));
    }

    function renderHudContent() {
      if (!hudBody) return;
      hudBody.innerHTML = '';

      if (hudFooter) {
        if (lastScanTime > 0) {
          const ago = Math.floor((Date.now() - lastScanTime) / 60000);
          const timeText = ago === 0 ? 'just now' : `${ago} min ago`;
          hudFooter.innerHTML = `Last scan: ${timeText} · ${cachedJobs.length} matched<br/>via ${lastScanPlatform} scraper`;
          hudFooter.style.display = 'block';
        } else {
          hudFooter.style.display = 'none';
        }
      }

      if (isScanInProgress) {
        hudBody.innerHTML = `<div class="hud-state"><div class="spinner-small" style="margin:0 auto 12px;"></div><h3>Scanning…</h3><p>Reading jobs from this page. Results will appear here shortly.</p></div>`;
        return;
      }

      if (!isTracked) {
        hudBody.innerHTML = `
          <div class="hud-state">
            <h3>Not tracked</h3>
            <p>This page isn't being tracked yet. Add it to start getting alerts.</p>
            <button class="btn-primary" id="nr-track-btn">+ Track this page</button>
          </div>
        `;
        hudBody.querySelector('#nr-track-btn')?.addEventListener('click', trackAndScan);
        return;
      }

      if (cachedJobs.length === 0) {
        hudBody.innerHTML = `<div class="hud-state"><h3>No matches</h3><p>No jobs on this page match your profile criteria.</p></div>`;
        return;
      }

      cachedJobs.forEach(job => {
        const card = document.createElement('div');
        card.className = 'hud-job';
        card.innerHTML = `
          <div class="hud-job-title">${job.title}</div>
          ${job.matchReason ? `<div class="hud-job-reason">Matched: ${job.matchReason.replace(':', ' · ')}</div>` : ''}
          <div class="hud-job-meta">
            ${job.companyName ? `<span>${job.companyName}</span>` : ''}
            ${job.location ? `<span>· ${job.location}</span>` : ''}
            ${!job.seenAt ? '<span class="badge-new">NEW</span>' : ''}
          </div>
        `;
        card.addEventListener('click', () => { if (job.url) window.open(job.url, '_blank'); });
        hudBody!.appendChild(card);
      });
    }

    function handlePillClick() {
      if (currentPillState === 'loading') return;
      if (!isTracked) {
        trackAndScan();
        return;
      }
      hudPanel?.classList.toggle('open');
    }

    function extractCompanyForHeader(): string {
      try {
        const og = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
        if (og) return og.toUpperCase();
        const host = window.location.hostname.replace('www.', '');
        if (host.includes('linkedin.com')) {
          const match = window.location.pathname.match(/\/company\/([^/]+)/);
          if (match) return match[1].replace(/-/g, ' ').toUpperCase();
        }
        if (host.includes('greenhouse.io') || host.includes('lever.co') || host.includes('ashbyhq.com')) {
           const path = window.location.pathname.split('/')[1];
           if (path && path !== 'jobs') return path.replace(/-/g, ' ').toUpperCase();
        }
        const h1 = document.querySelector('h1');
        if (h1 && h1.textContent && h1.textContent.length < 30) return h1.textContent.trim().toUpperCase();
        return host.split('.')[0].toUpperCase();
      } catch {
        return window.location.hostname.toUpperCase();
      }
    }

    // ──────────────────────────────────────────────────
    // BOOT
    // ──────────────────────────────────────────────────
    async function boot() {
      if (isLoginOrAuthPage(window.location.href)) {
        removePillIfExists();
        return;
      }
      if (!isCareerPage(window.location.href, document)) return;

      removePillIfExists();
      const hudRes = createHudShadow();
      hudRoot = hudRes.host;
      hudShadow = hudRes.shadow;

      const pillRes = createPillShadow();
      pillRoot = pillRes.host;
      pillShadow = pillRes.shadow;

      const companyName = extractCompanyForHeader();

      const pages = await trackedPagesStorage.getValue() ?? [];
      const normalized = normalizeCareerUrl(window.location.href);
      const existing = pages.find(p => p.normalizedUrl === normalized);
      isTracked = !!existing;

      pillButton = document.createElement('div');
      pillButton.addEventListener('click', handlePillClick);
      pillShadow.appendChild(pillButton);
      
      buildHud(companyName);
      setPillState(isTracked ? 'tracking' : 'available');

      browser.runtime.onMessage.addListener((msg: any) => {
        if (msg.type === 'NEW_JOBS_FOR_PAGE' && msg.payload.url === window.location.href) {
          cachedJobs = msg.payload.jobs;
          setPillState('tracking-new', cachedJobs.filter(j => !j.seenAt).length);
          renderHudContent();
        } else if (msg.type === 'TRIGGER_SCAN') {
          if (isTracked) runPageScanWithRetry();
        }
      });

      const allJobs = await unseenJobsStorage.getValue() || [];
      cachedJobs = allJobs.filter(j => j.sourcePageUrl === window.location.href);
      
      if (isTracked) {
        const newCount = cachedJobs.filter(j => !j.seenAt).length;
        setPillState(newCount > 0 ? 'tracking-new' : 'tracking', newCount);
        renderHudContent();
        
        window.addEventListener('load', () => setTimeout(runPageScanWithRetry, 2000));
        if (document.readyState === 'complete') setTimeout(runPageScanWithRetry, 500);
      } else {
        setPillState('available');
        renderHudContent();
      }
    }

    let lastUrl = window.location.href;
    let mutationCooldown = false;
    const urlObserver = new MutationObserver(() => {
      if (mutationCooldown) return;
      
      const currentUrl = window.location.href;
      if (currentUrl === lastUrl) return;
      
      mutationCooldown = true;
      setTimeout(() => { mutationCooldown = false; }, 2000);
      
      lastUrl = currentUrl;
      
      if (isLoginOrAuthPage(currentUrl)) {
        removePillIfExists();
        return;
      }
      
      if (currentUrl === lastScannedUrl) return;
      if (isScanInProgress) return;
      
      clearTimeout(scanDebounceTimer);
      scanDebounceTimer = setTimeout(() => {
        if (isCareerPage(currentUrl, document)) {
          cachedJobs = [];
          isTracked = false;
          lastScanTime = 0;
          setTimeout(boot, 500);
        } else {
          removePillIfExists();
        }
      }, 1500);
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });
    ctx.onInvalidated(() => urlObserver.disconnect());
    interceptSPANavigation();
    boot();
  },
});
