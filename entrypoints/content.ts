import { browser } from 'wxt/browser';
import {
  trackedPagesStorage,
  unseenJobsStorage,
  profileStorage,
  isCareerPage,
  StoredJob,
  remoteSelectorsStorage,
} from '../lib/storage';
import { detectPlatform, injectSortParam, hasSortParam, normalizeCareerUrl } from '../lib/utils';
import { extractFollowedCompaniesDom, isLinkedInPagesUrl, isFollowedCompaniesApiUrl, parseFollowedCompaniesResponse } from '../lib/slugExtractor';
import { getJobStore, markJobApplied } from '../lib/jobStore';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    // [NEXTROLE-FIX-B2] Guard: if extension context is already invalid on load, bail out cleanly
    function isExtensionContextValid(): boolean {
      try {
        // Accessing browser.runtime.id throws if context is invalid
        return !!browser.runtime.id
      } catch {
        return false
      }
    }

    if (!isExtensionContextValid()) {
      console.warn('[NextRole] Extension context invalid on load, skipping init')
      // do not return here - let the rest of the content script run
    }

    // [NEXTROLE-FIX-B2] Safe message sender that silently handles inactive service worker
    async function safeSendMessage(message: object): Promise<void> {
      try {
        await browser.runtime.sendMessage(message)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
          msg.includes('Extension context invalidated') ||
          msg.includes('Could not establish connection') ||
          msg.includes('receiving end does not exist')
        ) {
          return // expected, not an error
        }
        console.warn('[NextRole:Content] Unexpected message error:', msg)
      }
    }
    // [NEXTROLE-FIX-B1] — Voyager API intercept
    ;(function installFetchIntercept() {
      if ((window as any).__nr_fetch_intercepted) return
      ;(window as any).__nr_fetch_intercepted = true

      const _originalFetch = window.fetch.bind(window)
      window.fetch = async function(...args: Parameters<typeof fetch>) {
        const response = await _originalFetch(...args)

        try {
          let url = ''
          try {
            if (typeof args[0] === 'string') url = args[0]
            else if (args[0] instanceof URL) url = args[0].href
            else if (args[0] instanceof Request) url = args[0].url
          } catch { return response }

          if (!url.startsWith('https://www.linkedin.com')) return response
          if (url.startsWith('https://www.linkedin.com/li/')) return response
          if (url.includes('sensorCollect')) return response
          if (url.includes('realtime')) return response
          if (url.includes('li/track')) return response

          const isJobEndpoint =
            (url.includes('/api/jobs') && !url.includes('/api/jobsV2/tracker')) ||
            url.includes('/voyager/api/jobs') ||
            url.includes('jobPostings') ||
            url.includes('jobPosting?') ||
            (url.includes('/jobs-guest/jobs') && url.includes('currentJobId'))

          // [FIX-2A] Intercept followed companies API
          const isFollowingEndpoint = isFollowedCompaniesApiUrl(url)

          if (!isJobEndpoint && !isFollowingEndpoint) return response

          if (isFollowingEndpoint) {
            const cloned2 = response.clone()
            cloned2.json().then((rawJson: unknown) => {
              const companies = parseFollowedCompaniesResponse(rawJson)
              if (companies.length > 0) {
                (window as any).__nrApiExtractedCompanies = true;
                safeSendMessage({
                  type: 'UPDATE_FOLLOWED_COMPANIES',
                  payload: companies
                })
              }
            }).catch(() => {})
          }

          if (!isJobEndpoint) return response

          let cloned: Response
          try {
            cloned = response.clone()
          } catch { return response }

          cloned.json().then((rawJson: unknown) => {
            let slug = ''
            try {
              const urlObj = new URL(url)
              slug = urlObj.searchParams.get('f_C') || ''
              
              if (!slug) {
                const urn = urlObj.searchParams.get('organizationUrn')
                if (urn) {
                  const match = urn.match(/urn:li:organization:(\d+)/)
                  slug = match ? match[1] : urn
                }
              }
            } catch {}

            if (!slug) {
              const fCmatch = url.match(/f_C,value:List\(([^)]+)\)/)
              if (fCmatch) slug = fCmatch[1]
            }

            if (!slug) {
              const slugMatch = url.match(/\/company\/([a-zA-Z0-9\-_\.]+)\/jobs/)
              if (slugMatch) slug = slugMatch[1]
            }

            safeSendMessage({
              type: 'VOYAGER_JOB_DATA',
              payload: { rawJson, companySlug: slug, companyName: slug, companyLogoUrl: '' }
            })
          }).catch(() => {})

        } catch {
        }
        return response
      }
    })()

    // [NEXTROLE-FIX-B4] — LinkedIn Pages company extraction
    function tryExtractAndSendCompanies() {
      const companies = extractFollowedCompaniesDom(document)
      if (companies.length > 0) {
        safeSendMessage({
          type: 'UPDATE_FOLLOWED_COMPANIES',
          payload: companies
        })
        showNrToast(`NextRole: Found ${companies.length} companies to monitor`)
      }
    }

    // [FIX-2C] On LinkedIn Pages URL — use API intercept as primary,
    // DOM as timed fallback only
    if (isLinkedInPagesUrl(window.location.href)) {
      let domAttempts = 0
      const domFallback = () => {
        if ((window as any).__nrApiExtractedCompanies) return; // Skip if API intercept succeeded
        
        domAttempts++
        const companies = extractFollowedCompaniesDom(document)
        if (companies.length > 0) {
          safeSendMessage({ type: 'UPDATE_FOLLOWED_COMPANIES', payload: companies })
          showNrToast(`NextRole: Tracking ${companies.length} followed companies`)
        } else if (domAttempts < 2) {
          setTimeout(domFallback, 5000)
        } else {
          console.log('[NextRole:Slugs] DOM fallback exhausted — waiting for API intercept')
        }
      }
      setTimeout(domFallback, 3000)
    }

    // [NEXTROLE-V1-NEW]
    function showNrToast(message: string) {
      const existing = document.getElementById('nr-toast')
      if (existing) existing.remove()

      const toast = document.createElement('div')
      toast.id = 'nr-toast'
      toast.textContent = message
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        background: rgba(10, 22, 40, 0.95);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(0, 240, 255, 0.4);
        color: #00f0ff;
        font-family: 'JetBrains Mono', monospace, sans-serif;
        font-size: 12px;
        padding: 10px 16px;
        border-radius: 8px;
        box-shadow: 0 0 16px rgba(0, 240, 255, 0.2);
        pointer-events: none;
        transition: opacity 0.3s ease;
      `
      document.body.appendChild(toast)
      setTimeout(() => {
        toast.style.opacity = '0'
        setTimeout(() => toast.remove(), 300)
      }, 3500)
    }
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

    let urlChangeTimer: any;
    let lastHandledUrl = '';

    function handleUrlChange() {
      const currentUrl = window.location.href
      if (currentUrl === lastHandledUrl) return
      if (isLoginOrAuthPage(currentUrl)) { removePillIfExists(); return }
      
      clearTimeout(urlChangeTimer)
      urlChangeTimer = setTimeout(() => {
        lastHandledUrl = currentUrl
        if (isCareerPage(currentUrl, document)) {
          boot()
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
        const sortedUrl = injectSortParam(normalizeCareerUrl(window.location.href), platform);
        
        const isListingPage = isJobListingPage(window.location.href, platform);
        if (isListingPage && sortedUrl !== normalizeCareerUrl(window.location.href) && !hasSortParam(window.location.href, platform)) {
          if (isSpaPage(platform)) {
            window.history.replaceState({}, '', sortedUrl);
            window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            await new Promise(r => setTimeout(r, retryDelayMs * attempt));
          }
          
          const { scrapeCurrentPage } = await import('../lib/clientScraper');
          const remoteSelectors = await remoteSelectorsStorage.getValue() || {};
          const result = scrapeCurrentPage(document, window.location.href, remoteSelectors);

          lastScanTime = Date.now();
          lastScanPlatform = result.platform;

          if (result.jobs.length > 0) {
            await safeSendMessage({
              type: 'PAGE_SCAN_RESULT',
              payload: { url: window.location.href, platform: result.platform, jobs: result.jobs, scannedAt: lastScanTime }
            });
            setPillState(isTracked ? 'tracking' : 'available');
            renderHudContent();
            return;
          }

          const isSpaPlatform = isSpaPage(result.platform);
          if (!isSpaPlatform || attempt === maxRetries) {
            await safeSendMessage({
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
        renderHudContent();
      }
    }

    function isJobListingPage(url: string, platform: string): boolean {
      try {
        const path = new URL(url).pathname.toLowerCase()
        const jobDetailPatterns = ['/jobs/view/', '/job/', '/jobdetail', '/position/',
                                    '/careers/job/', '/jobs/results/12', '/requisition/']
        if (jobDetailPatterns.some(p => path.includes(p))) return false
        return true
      } catch { return false }
    }

    function isSpaPage(platform: string): boolean {
      return ['eightfold', 'google', 'workday', 'greenhouse', 'ashby',
              'wellfound', 'workable', 'linkedin'].includes(platform)
    }

    async function trackAndScan() {
      const currentUrl = window.location.href;
      const platform = detectPlatform(currentUrl);
      const normalized = normalizeCareerUrl(currentUrl);
      const sortedUrl = injectSortParam(normalized, platform);
      
      const pages = await trackedPagesStorage.getValue() ?? [];
      
      if (!pages.find(p => p.normalizedUrl === normalizeCareerUrl(sortedUrl))) {
        pages.push({
          id: crypto.randomUUID(),
          url: sortedUrl,
          displayUrl: currentUrl,
          normalizedUrl: normalizeCareerUrl(sortedUrl),
          label: document.title || 'Career Page',
          subtitle: window.location.hostname,
          addedAt: Date.now(),
          lastScrapedAt: 0,
          lastScrapeStatus: 'pending',
          lastScrapeError: null,
          newJobCount: 0,
          isPending: false,
          platform: platform,
        });
        await trackedPagesStorage.setValue(pages);
      }
      isTracked = true;
      setPillState('loading');
      
      const { scrapeCurrentPage } = await import('../lib/clientScraper');
      const remoteSelectors = await remoteSelectorsStorage.getValue() || {};
      const result = scrapeCurrentPage(document, currentUrl, remoteSelectors);
      
      if (result.jobs.length > 0) {
        // Will be updated by PAGE_SCAN_RESULT response via listener
        await safeSendMessage({
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

      await safeSendMessage({
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
        <div style="padding: 12px 12px 0 12px;">
          <button id="nr-scan-now-btn" class="btn-primary" style="margin-top: 0; background: transparent; color: #00f0ff; border-color: #00f0ff;">⚡ Scan Now</button>
        </div>
        <div class="hud-body"></div>
        <div class="hud-footer"></div>
      `;
      hudShadow.appendChild(hudPanel);
      hudBody = hudPanel.querySelector('.hud-body');
      hudFooter = hudPanel.querySelector('.hud-footer');
      hudPanel.querySelector('.hud-close')!.addEventListener('click', () => hudPanel?.classList.remove('open'));
      
      const scanBtn = hudPanel.querySelector('#nr-scan-now-btn') as HTMLButtonElement;
      if (scanBtn) {
        scanBtn.addEventListener('click', () => {
          scanBtn.textContent = 'Scanning...';
          scanBtn.disabled = true;
          safeSendMessage({ type: 'MANUAL_SCAN' });
        });
      }
    }

    function escapeHtml(str: string | undefined): string {
      if (!str) return '';
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }

    async function renderHudContent() {
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

      // LinkedIn Job Alerts V1 - render from jobStore
      try {
        const store = await getJobStore();
        if (store.jobs && store.jobs.length > 0) {
          const jobs = store.jobs.sort((a, b) => b.detectedAt - a.detectedAt);
          
          let html = '';
          for (const job of jobs) {
            const ago = Math.floor((Date.now() - job.detectedAt) / 60000);
            const timeText = ago === 0 ? 'Just now' : ago < 60 ? `${ago} min ago` : `${Math.floor(ago/60)} hrs ago`;
            
            let badgeColor = '#888';
            if (job.matchScore >= 70) badgeColor = 'var(--green)';
            else if (job.matchScore >= 40) badgeColor = 'var(--amber)';
            
            html += `
              <div class="hud-job" style="border-left: 4px solid ${badgeColor};" data-apply="${escapeHtml(job.applyUrl)}" data-id="${escapeHtml(job.id)}">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                  <img src="${escapeHtml(job.companyLogoUrl) || 'https://www.google.com/s2/favicons?domain=linkedin.com&sz=32'}" style="width:24px;height:24px;border-radius:4px;background:#fff;" onerror="this.style.display='none'"/>
                  <div class="hud-job-title" style="margin:0;">${escapeHtml(job.role)}</div>
                </div>
                <div class="hud-job-meta">
                  <span>${escapeHtml(job.company)}</span>
                  <span>· ${escapeHtml(job.location)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                  <span style="font-size:10px; color:#555;">${timeText}</span>
                  <div style="display:flex; gap:6px; align-items:center;">
                    <span style="font-size:9px; background:${badgeColor}; color:#000; padding:2px 6px; font-weight:800; border:1px solid #000;">Score: ${job.matchScore}</span>
                    <button class="nr-apply-btn" style="background:transparent; color:#00f0ff; border:1px solid #00f0ff; padding:2px 8px; font-size:10px; cursor:pointer;">Apply →</button>
                  </div>
                </div>
              </div>
            `;
          }
          hudBody.innerHTML = html;
          
          // Add event listeners for apply buttons
          const cards = hudBody.querySelectorAll('.hud-job');
          cards.forEach(card => {
            const btn = card.querySelector('.nr-apply-btn');
            if (btn) {
              btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const url = (card as HTMLElement).dataset.apply;
                const id = (card as HTMLElement).dataset.id;
                if (url) window.open(url, '_blank');
                if (id) await markJobApplied(id);
              });
            }
          });
          return;
        }
      } catch (e) {
        console.warn('Failed to load jobs from jobStore', e);
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
          <div class="hud-job-title">${escapeHtml(job.title)}</div>
          ${job.matchReason ? `<div class="hud-job-reason">Matched: ${escapeHtml(job.matchReason).replace(':', ' · ')}</div>` : ''}
          <div class="hud-job-meta">
            ${job.companyName ? `<span>${escapeHtml(job.companyName)}</span>` : ''}
            ${job.location ? `<span>· ${escapeHtml(job.location)}</span>` : ''}
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

      if (!(window as any).__nrListenerAdded) {
        (window as any).__nrListenerAdded = true;
        browser.runtime.onMessage.addListener((msg: any) => {
          if (msg.type === 'NEW_JOBS_FOR_PAGE' && msg.payload.url === window.location.href) {
            cachedJobs = msg.payload.jobs;
            setPillState('tracking-new', cachedJobs.filter((j: any) => !j.seenAt).length);
            renderHudContent();
          } else if (msg.type === 'TRIGGER_SCAN') {
            if (isTracked) runPageScanWithRetry();
          } else if (msg.type === 'FETCH_COMPANY_JOBS') {
            const { slug, name, logoUrl, companyId } = msg.payload as {
              slug: string; name: string; logoUrl: string; companyId?: string
            }

            // [FIX-2B] Direct API fetch — does NOT navigate the tab
            // The fetch intercept will catch this response automatically
            const orgParam = companyId ? `urn%3Ali%3Aorganization%3A${companyId}` : slug
            const voyagerUrl =
              `https://www.linkedin.com/voyager/api/jobs/jobPostings` +
              `?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebLimitedJobPosting-60` +
              `&count=20&q=organization&organizationUrn=${orgParam}` +
              `&start=0`

            // Also try the company-specific jobs endpoint
            const altUrl =
              `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/` +
              `?f_C=${slug}&start=0`

            // Fire both — intercept will catch whichever returns job data
            const csrfToken = document.cookie.match(/JSESSIONID="?([^";]+)"?/)?.[1] || '';

            window.fetch(voyagerUrl, {
              headers: {
                'Accept': 'application/vnd.linkedin.normalized+json+2.1',
                'x-li-lang': 'en_US',
                'x-restli-protocol-version': '2.0.0',
                'csrf-token': csrfToken,
              },
              credentials: 'include'  // uses user's LinkedIn session
            }).catch(() => {})

            window.fetch(altUrl, {
              credentials: 'include'
            }).catch(() => {})
          } else if (msg.type === 'TRY_EXTRACT_COMPANIES') {
            // [NEXTROLE-V1-NEW] handle TRY_EXTRACT_COMPANIES
            if (typeof tryExtractAndSendCompanies === 'function') {
              tryExtractAndSendCompanies();
            }
          } else if (msg.type === 'SCAN_COMPLETE') {
            if (hudPanel) {
              const scanBtn = hudPanel.querySelector('#nr-scan-now-btn') as HTMLButtonElement;
              if (scanBtn) {
                scanBtn.textContent = '⚡ Scan Now';
                scanBtn.disabled = false;
              }
            }
            renderHudContent();
          }
        });
      }

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
    const urlCheckInterval = setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl === lastUrl) return;
      
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
    }, 1000);
    ctx.onInvalidated(() => clearInterval(urlCheckInterval));
    interceptSPANavigation();
    boot();
  },
});
