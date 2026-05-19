export default defineContentScript({
  matches: ['<all_urls>'],
  main(ctx) {
    console.log('[NextRole] Content script loaded. Running career page detection...');

    // 1. Run initial detection
    handleDetection();

    // 2. Fix the SPA Dynamic Navigation Issue:
    // Listen for dynamic URL changes using a DOM MutationObserver (which catches History API pushState/replaceState transitions)
    let lastUrl = window.location.href;
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        console.log(`[NextRole] Dynamic URL transition detected: ${lastUrl}. Re-checking career portal status...`);
        handleDetection();
      }
    });
    observer.observe(document, { subtree: true, childList: true });

    // Gracefully clean up MutationObserver when extension is reloaded or script is invalidated
    ctx.onInvalidated(() => {
      observer.disconnect();
      
      const panel = document.getElementById('nextrole-side-panel');
      if (panel) panel.remove();
      
      const trigger = document.getElementById('nextrole-side-trigger');
      if (trigger) trigger.remove();
      
      console.log('[NextRole] Content script context invalidated. Cleaned up MutationObserver and orphaned UI.');
    });

    // Also listen for standard popstate browser navigation events using the WXT context listener
    ctx.addEventListener(window, 'popstate', () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        handleDetection();
      }
    });

    // Also listen for background navigation pings from background.ts
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'SCAN_ACTIVE_PORTAL') {
        console.log('[NextRole] Received background ping: Scanning portal...');
        handleDetection();
        sendResponse({ success: true });
      }
    });

  },
});

// Helper function to safely send fetches through the background script.
// This completely bypasses webpage Content Security Policies (CSP) and gracefully prevents invalidation errors.
async function safeBackendFetch(
  url: string, 
  options: { method?: string; headers?: Record<string, string>; body?: any } = {}
): Promise<{ success: boolean; data?: any; error?: string }> {
  // If the extension context is invalidated, abort immediately to prevent invalid runtime calls
  if (typeof browser === 'undefined' || !browser.runtime?.id) {
    console.warn('[NextRole] Extension context was invalidated. Aborting background fetch.');
    return { success: false, error: 'Context invalidated' };
  }
  try {
    const response = await browser.runtime.sendMessage({
      action: 'fetchBackend',
      url,
      method: options.method,
      headers: options.headers,
      body: options.body
    });
    return response || { success: false, error: 'Empty response' };
  } catch (err: any) {
    console.warn('[NextRole] Delegated fetch message failed (context probably invalidated):', err);
    return { success: false, error: err.message || 'Context invalidated' };
  }
}

// Resilient Session Storage Wrappers to prevent SecurityError crashes in Incognito/Strict Privacy modes
function safeGetDismissedState(): boolean {
  try {
    return sessionStorage.getItem('nextrole-panel-dismissed') === 'true';
  } catch (e) {
    console.warn('[NextRole] sessionStorage access denied by browser privacy settings.');
    return false;
  }
}

function safeSetDismissedState(isDismissed: boolean) {
  try {
    if (isDismissed) {
      sessionStorage.setItem('nextrole-panel-dismissed', 'true');
    } else {
      sessionStorage.removeItem('nextrole-panel-dismissed');
    }
  } catch (e) {
    console.warn('[NextRole] sessionStorage access denied by browser privacy settings.');
  }
}

async function handleDetection(retryCount = 0) {
  const isCareerPage = detectCareerPage();
  
  // Start the background list scraper safely
  startLinkedInScraper();

  if (isCareerPage) {
    const company = getCompanyName();
    const currentUrl = window.location.href;
    const existingPanel = document.getElementById('nextrole-side-panel');

    if (existingPanel) {
      // Panel already loaded, just update its company details and reload database tracking states for the new URL!
      const displaySpan = existingPanel.querySelector('#nr-company-display');
      if (displaySpan) {
        displaySpan.textContent = company;
      }
      
      const isDismissed = safeGetDismissedState();
      if (!isDismissed) {
        existingPanel.style.transform = 'translateX(0)';
        existingPanel.style.opacity = '1';
        existingPanel.style.pointerEvents = 'auto';
        
        // Hide trigger if shown
        const trigger = document.getElementById('nextrole-side-trigger');
        if (trigger) {
          trigger.style.transform = 'scale(0) translateY(10px)';
          trigger.style.opacity = '0';
          trigger.style.pointerEvents = 'none';
        }
      }
      await updatePanelData(existingPanel, currentUrl, company);
    } else {
      // Injected for the first time, draw the panel
      await injectSidePanel();
      
      if (safeGetDismissedState()) {
        injectFloatingTrigger();
      }
    }
  } else {
    // If not detected immediately, retry up to 2 times to account for slow SPA React/Vue DOM hydration delays
    if (retryCount < 2) {
      setTimeout(() => handleDetection(retryCount + 1), 800);
      return;
    }

    // If the user navigates away from a career portal completely, slide the side panel out of view automatically!
    const panel = document.getElementById('nextrole-side-panel');
    if (panel) {
      panel.style.transform = 'translateX(360px)';
      panel.style.opacity = '0';
      panel.style.pointerEvents = 'none';
    }
    const trigger = document.getElementById('nextrole-side-trigger');
    if (trigger) {
      trigger.style.transform = 'scale(0) translateY(10px)';
      trigger.style.opacity = '0';
      trigger.style.pointerEvents = 'none';
    }
  }
}

function runUniversalHeuristicScan() {
  let matches: any[] = [];
  let companyName = '';
  
  // Strategy A: Parse Google Job Posting Standard Structs (Universal JSON-LD)
  const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  jsonLdScripts.forEach(script => {
    try {
      // Some scripts contain arrays of JSON objects
      let rawData = JSON.parse(script.textContent || '');
      const dataArray = Array.isArray(rawData) ? rawData : [rawData];
      
      dataArray.forEach(data => {
        if (data['@type'] === 'JobPosting' || (data['@graph'] && data['@graph'].some((g: any) => g['@type'] === 'JobPosting'))) {
          const targetNode = data['@type'] === 'JobPosting' ? data : data['@graph'].find((g: any) => g['@type'] === 'JobPosting');
          matches.push({
            title: targetNode.title || targetNode.name,
            company: targetNode.hiringOrganization?.name
          });
          if (targetNode.hiringOrganization?.name) {
            companyName = targetNode.hiringOrganization.name;
          }
        }
      });
    } catch (e) { /* Safe catch for malformed scripts */ }
  });

  // Strategy B: Fallback to common target list anchors if no metadata script exists
  if (matches.length === 0) {
    const criticalSelectors = ['a[href*="/job/"]', 'a[href*="/career/"]', 'a[href*="/position/"]', '[class*="job-title"]', 'h1'];
    criticalSelectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(element => {
        const text = element.textContent?.trim() || '';
        if (text.length > 4 && text.length < 80) {
          matches.push({ title: text, rawElement: element });
        }
      });
    });
  }

  return {
    isMatchFound: matches.length > 0,
    matches: matches,
    companyName: companyName
  };
}

function detectCareerPage(): boolean {
  const url = window.location.href.toLowerCase();

  // 1. High-Fidelity JSON-LD Metadata Check
  const telemetry = runUniversalHeuristicScan();
  if (telemetry.isMatchFound && telemetry.companyName) {
    return true; // Absolute certainty it's a job portal
  }

  // 2. Hardcoded check for the 3 target platforms
  if (
    url.includes('myworkdayjobs.com') ||
    url.includes('boards.greenhouse.io') ||
    url.includes('jobs.lever.co') ||
    url.includes('linkedin.com/jobs') ||
    url.includes('wellfound.com/jobs')
  ) {
    return true;
  }

  // 3. Common career portal sub-paths in URL
  if (
    url.includes('/careers') ||
    url.includes('/jobs') ||
    url.includes('/positions') ||
    url.includes('/postings') ||
    url.includes('/openings') ||
    url.includes('/join-us')
  ) {
    return true;
  }

  // 3. Search HTML body content for distinct patterns
  if (document.body) {
    const bodyText = document.body.innerText.toLowerCase();
    
    // Check for high-probability career page keywords
    const keywords = [
      'job listings',
      'open positions',
      'current openings',
      'open roles',
      'explore opportunities',
      'view open jobs',
      'careers at',
      'search jobs',
      'hiring'
    ];

    // Must match at least two keywords to avoid false positives, OR one extremely strong phrase
    const strongPhrases = ['job listings', 'open positions', 'current openings', 'open roles'];
    for (const phrase of strongPhrases) {
      if (bodyText.includes(phrase)) {
        return true;
      }
    }

    let matchCount = 0;
    for (const word of keywords) {
      if (bodyText.includes(word)) {
        matchCount++;
        if (matchCount >= 2) {
          return true;
        }
      }
    }
  }

  return false;
}

function getCompanyName(): string {
  // 1. Prioritize structural JSON-LD metadata if available
  const telemetry = runUniversalHeuristicScan();
  if (telemetry.companyName) {
    return telemetry.companyName;
  }

  // 2. Fallback to URL parsers
  const url = new URL(window.location.href);
  const hostname = url.hostname.toLowerCase();
  
  if (hostname.includes('myworkdayjobs.com')) {
    const parts = hostname.split('.');
    if (parts.length > 0) {
      return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    }
  } else if (hostname.includes('greenhouse.io')) {
    const parts = url.pathname.split('/');
    if (parts.length > 1 && parts[1]) {
      return parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    }
  } else if (hostname.includes('lever.co')) {
    const parts = url.pathname.split('/');
    if (parts.length > 1 && parts[1]) {
      return parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    }
  }
  
  // 3. Clean up title as final fallback
  let title = document.title;
  if (title) {
    title = title.replace(/(careers|jobs|openings|positions|hiring|work with us|opportunities|job board)/gi, '').trim();
    title = title.replace(/^[\s\-\|]+|[\s\-\|]+$/g, '').trim();
    if (title) return title;
  }
  
  return hostname;
}

async function injectSidePanel() {
  // Prevent duplicate panel injections
  if (document.getElementById('nextrole-side-panel')) return;

  const company = getCompanyName();
  const currentUrl = window.location.href;
  const isDismissed = safeGetDismissedState();

  // 1. Create Panel Element container
  const panel = document.createElement('div');
  panel.id = 'nextrole-side-panel';
  
  panel.innerHTML = `
    <style>
      @keyframes nr-logo-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .nr-side-logo-spin { animation: nr-logo-spin 15s linear infinite; }
      #nextrole-side-panel {
        --bg: #051424;
        --surface: #0d1c2d;
        --surface2: #0a1628;
        --border: rgba(0,240,255,0.12);
        --border2: rgba(255,255,255,0.06);
        --yellow: #f0ff00;
        --cyan: #00f0ff;
        --text: #e2eaf4;
        --muted: #4a6080;
        --font: 'Space Grotesk', sans-serif;
        --mono: 'JetBrains Mono', monospace;
      }
      .nr-hdr { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 16px 0; display: flex; flex-direction: column; position: relative; }
      .nr-close-btn { position: absolute; top: 8px; right: 8px; background: none; border: none; color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; transition: all 0.2s ease; outline: none; padding: 0; }
      .nr-close-btn:hover { color: #ffffff; background: rgba(255, 255, 255, 0.06); }
      .nr-logo-text { text-align: center; font-family: var(--mono); font-size: 16px; font-weight: 700; color: var(--yellow); letter-spacing: 2px; text-shadow: 0 0 18px rgba(240,255,0,0.45); padding-bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 8px; }
      .nr-tab-bar { display: flex; gap: 0; }
      .nr-tab-btn { flex: 1; background: none; border: none; color: var(--muted); font-family: var(--font); font-size: 11px; font-weight: 600; padding: 8px 4px; cursor: pointer; position: relative; transition: color .2s; display: flex; align-items: center; justify-content: center; gap: 5px; outline: none; }
      .nr-tab-btn.active { color: var(--yellow); }
      .nr-tab-btn.active::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: var(--yellow); border-radius: 2px 2px 0 0; box-shadow: 0 0 8px var(--yellow); }
      .nr-tab-btn:not(.active):hover { color: var(--cyan); }
      
      .nr-view { display: none; flex-direction: column; gap: 10px; padding: 12px 14px; flex: 1; overflow-y: auto; }
      .nr-view.active { display: flex; }
      
      .nr-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
      .nr-card-label { font-family: var(--mono); font-size: 8px; font-weight: 700; text-transform: uppercase; color: var(--cyan); letter-spacing: 0.8px; }
      .nr-card-title { font-size: 13.5px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 6px; }
      
      .time-filter-row { display: flex; gap: 8px; margin-top: 8px; }
      .time-btn { flex: 1; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border2); border-radius: 6px; color: var(--muted); font-family: var(--mono); font-size: 9px; font-weight: 700; padding: 6px; cursor: pointer; transition: all 0.2s ease; outline: none; }
      .time-btn.active { background: rgba(0, 240, 255, 0.1); border-color: var(--cyan); color: var(--cyan); box-shadow: 0 0 10px rgba(0, 240, 255, 0.1); }
      .time-btn:not(.active):hover { color: var(--text); background: rgba(255, 255, 255, 0.08); }

      .nr-feed-list { display: flex; flex-direction: column; gap: 8px; }
      .nr-feed-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; transition: border-color 0.2s ease; }
      .nr-feed-card:hover { border-color: rgba(0, 240, 255, 0.3); }
      .nr-feed-card-title { font-size: 12px; font-weight: 700; color: var(--text); line-height: 1.3; }
      .nr-feed-card-meta { font-size: 10px; color: var(--muted); font-family: var(--mono); display: flex; flex-wrap: wrap; gap: 6px; }
      .nr-feed-card-tag { display: inline-flex; align-items: center; gap: 3px; background: rgba(0, 240, 255, 0.08); border: 1px solid rgba(0, 240, 255, 0.15); border-radius: 4px; padding: 2px 6px; font-family: var(--mono); font-size: 8px; font-weight: 700; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.5px; }
      .nr-feed-card-tag.today { background: rgba(240, 255, 0, 0.08); border-color: rgba(240, 255, 0, 0.2); color: var(--yellow); }
      .nr-feed-card-tag.week { background: rgba(0, 240, 120, 0.08); border-color: rgba(0, 240, 120, 0.2); color: #00f078; }
      .nr-feed-btn { margin-top: 2px; background: rgba(0, 240, 255, 0.08); border: 1px solid rgba(0, 240, 255, 0.2); border-radius: 6px; color: var(--cyan); font-family: var(--mono); font-size: 9px; font-weight: 700; padding: 5px 10px; cursor: pointer; transition: all 0.2s ease; text-align: left; outline: none; letter-spacing: 0.5px; }
      .nr-feed-btn:hover { background: rgba(0, 240, 255, 0.15); border-color: var(--cyan); box-shadow: 0 0 10px rgba(0, 240, 255, 0.2); }
      .terminal-alert { font-family: var(--mono); font-size: 10px; color: var(--muted); text-align: center; padding: 24px 12px; border: 1px dashed var(--border2); border-radius: 8px; line-height: 1.6; }
      
      .nr-footer { margin-top: auto; border-top: 1px solid var(--border2); padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--muted); font-family: var(--mono); background: var(--surface); }
      
      /* Scrollbar */
      #nextrole-side-panel ::-webkit-scrollbar { width: 4px; }
      #nextrole-side-panel ::-webkit-scrollbar-track { background: transparent; }
      #nextrole-side-panel ::-webkit-scrollbar-thumb { background: rgba(0,240,255,0.15); border-radius: 4px; }
      
      .nr-form-group { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
      .nr-form-group label { font-family: var(--mono); font-size: 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
      .nr-input, .nr-textarea { background: rgba(0, 0, 0, 0.25); border: 1px solid var(--border2); border-radius: 6px; padding: 6px 8px; color: var(--text); font-family: var(--font); font-size: 11px; outline: none; transition: border-color 0.2s ease; }
      .nr-input:focus, .nr-textarea:focus { border-color: var(--cyan); box-shadow: 0 0 8px rgba(0, 240, 255, 0.15); }
      .nr-textarea { resize: vertical; min-height: 50px; font-family: var(--mono); font-size: 9.5px; line-height: 1.4; }
      
      .nr-tag-container { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; min-height: 24px; padding: 4px; background: rgba(0, 0, 0, 0.15); border: 1px dashed var(--border2); border-radius: 6px; }
      .nr-tag { display: inline-flex; align-items: center; gap: 4px; background: rgba(0, 240, 255, 0.08); border: 1px solid rgba(0, 240, 255, 0.2); border-radius: 4px; padding: 2px 6px; font-family: var(--mono); font-size: 9px; color: var(--cyan); }
      .nr-tag-del { cursor: pointer; color: var(--muted); font-weight: bold; transition: color 0.15s; }
      .nr-tag-del:hover { color: #ff4a4a; }
      .nr-tag-input { background: rgba(0,0,0,0.25); border: 1px solid var(--border2); border-radius: 6px; padding: 4px 8px; color: var(--text); font-family: var(--mono); font-size: 9.5px; outline: none; width: 100%; box-sizing: border-box; }
      .nr-tag-input:focus { border-color: var(--cyan); }
      
      .nr-project-card { border: 1px solid var(--border2); border-radius: 8px; padding: 10px; background: var(--surface2); position: relative; margin-top: 8px; }
      .nr-project-card .nr-close-btn { top: 4px; right: 4px; }
    </style>

    <div class="nr-hdr">
      <button id="nr-close-panel" class="nr-close-btn">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
      <div class="nr-logo-text">
        <svg class="nr-side-logo-spin" style="width: 16px; height: 16px;" viewBox="0 0 24 24" fill="none" stroke="#00f0ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" />
          <polyline points="12 2 12 22" /><polyline points="12 12 22 8.5" /><polyline points="12 12 2 8.5" />
        </svg>
        NextRole
      </div>
      <div class="nr-tab-bar">
        <button class="nr-tab-btn active" data-view="copilot">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
          Co-Pilot
        </button>
        <button class="nr-tab-btn" data-view="resume">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          ATS Resume
        </button>
        <button class="nr-tab-btn" data-view="architect">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          Architect
        </button>
      </div>
    </div>

    <div style="display: flex; flex-direction: column; flex: 1; overflow: hidden;">
      <!-- View: Co-Pilot -->
      <div id="nr-view-copilot" class="nr-view active">
        <div class="nr-card">
          <span class="nr-card-label">// CAREER FEED ACTIVE</span>
          <div class="nr-card-title"><span>🏢</span> <span id="nr-company-display" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px;">${company}</span></div>
          <div style="margin-top: 6px; font-family: var(--mono); font-size: 8px; color: var(--muted);">// TIME HORIZON FILTER</div>
          <div class="time-filter-row">
            <button class="time-btn active" data-range="today">TODAY</button>
            <button class="time-btn" data-range="week">THIS WEEK</button>
            <button class="time-btn" data-range="all">ALL TIME</button>
          </div>
        </div>
        <div id="nr-action-container" style="transition: all 0.3s ease;">
          <div id="nr-feed-list" class="nr-feed-list"><div class="terminal-alert">// INITIALIZING FEED MATRIX...</div></div>
        </div>
      </div>

      <!-- View: ATS Resume -->
      <div id="nr-view-resume" class="nr-view">
        <div id="nr-resume-container" style="transition: all 0.3s ease;">
          <div style="color: var(--muted); text-align: center; font-size: 11px; font-family: var(--mono);">[ SYNCING ATS... ]</div>
        </div>
      </div>

      <!-- View: Architect -->
      <div id="nr-view-architect" class="nr-view">
        <div class="nr-card">
          <span class="nr-card-label">// IDENTITY & ACADEMICS</span>
          <div class="nr-form-group">
            <label>FULL NAME</label>
            <input type="text" id="nr-profile-fullname" class="nr-input" placeholder="e.g. John Doe">
          </div>
          <div class="nr-form-group">
            <label>UNIVERSITY</label>
            <input type="text" id="nr-profile-institution" class="nr-input" placeholder="e.g. IIT Delhi">
          </div>
          <div class="nr-form-group">
            <label>DEGREE</label>
            <input type="text" id="nr-profile-degree" class="nr-input" placeholder="e.g. B.Tech">
          </div>
          <div class="nr-form-group">
            <label>SPECIALIZATION</label>
            <input type="text" id="nr-profile-specialization" class="nr-input" placeholder="e.g. Computer Science">
          </div>
          <div class="nr-form-group">
            <label>GRADUATION YEAR</label>
            <input type="text" id="nr-profile-gradyear" class="nr-input" placeholder="e.g. 2026">
          </div>
        </div>

        <div class="nr-card">
          <span class="nr-card-label">// SKILLS VECTOR MATRIX</span>
          <div class="nr-form-group">
            <label>LANGUAGES</label>
            <div class="nr-tag-container" id="nr-tags-languages"></div>
            <input type="text" id="nr-input-languages" class="nr-tag-input" placeholder="Add Language + Enter">
          </div>
          <div class="nr-form-group">
            <label>FRAMEWORKS</label>
            <div class="nr-tag-container" id="nr-tags-frameworks"></div>
            <input type="text" id="nr-input-frameworks" class="nr-tag-input" placeholder="Add Framework + Enter">
          </div>
          <div class="nr-form-group">
            <label>DATABASES</label>
            <div class="nr-tag-container" id="nr-tags-databases"></div>
            <input type="text" id="nr-input-databases" class="nr-tag-input" placeholder="Add Database + Enter">
          </div>
          <div class="nr-form-group">
            <label>SPECIALIZED TECH</label>
            <div class="nr-tag-container" id="nr-tags-specializedTech"></div>
            <input type="text" id="nr-input-specializedTech" class="nr-tag-input" placeholder="Add Special Tech + Enter">
          </div>
        </div>

        <div class="nr-card">
          <span class="nr-card-label">// PROJECTS LEDGER</span>
          <div id="nr-projects-container" style="display: flex; flex-direction: column; gap: 8px;"></div>
          <button id="nr-btn-add-project" class="nr-feed-btn" style="text-align: center; margin-top: 8px;">+ ADD PROJECT INSTANCE</button>
        </div>

        <button id="nr-btn-save-profile" class="nr-feed-btn" style="text-align: center; margin-top: 8px; border-color: var(--cyan); background: rgba(0, 240, 255, 0.1); color: var(--cyan); font-weight: bold; width: 100%; height: 32px; display: flex; align-items: center; justify-content: center;">// COMMIT MASTER SYSTEM MATRIX</button>
        <div id="nr-profile-save-status" style="font-family: var(--mono); font-size: 8px; color: var(--muted); text-align: center; margin-top: 4px;">[ STATUS: INITIALIZED ]</div>
      </div>
      
      <div class="nr-footer">
        <span style="display: flex; align-items: center; gap: 6px;"><span style="background-color: var(--cyan); width: 5px; height: 5px; border-radius: 50%; display: inline-block; box-shadow: 0 0 6px var(--cyan);"></span>[ SECURE SYSTEM ]</span>
        <span id="nr-tracked-pages-count">0 channels online</span>
      </div>
    </div>
  `;

  // 2. Set Side Panel styling
  Object.assign(panel.style, {
    position: 'fixed',
    top: '24px',
    right: '24px',
    width: '320px',
    height: 'calc(100vh - 48px)',
    zIndex: '2147483647',
    background: '#051424',
    border: '1px solid rgba(0, 240, 255, 0.12)',
    borderRadius: '12px',
    boxShadow: '0 25px 60px -15px rgba(0, 240, 255, 0.15)',
    fontFamily: '"Space Grotesk", system-ui, -apple-system, sans-serif',
    transition: 'all 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    transform: isDismissed ? 'translateX(360px)' : 'translateX(0)',
    opacity: isDismissed ? '0' : '1',
    pointerEvents: isDismissed ? 'none' : 'auto',
    boxSizing: 'border-box',
  });

  // 3. Close panel event action
  const closeBtn = panel.querySelector('#nr-close-panel') as HTMLElement;
  closeBtn?.addEventListener('click', () => {
    safeSetDismissedState(true);
    panel.style.transform = 'translateX(360px)';
    panel.style.opacity = '0';
    panel.style.pointerEvents = 'none';
    
    // Inject the launcher button trigger in the corner
    injectFloatingTrigger();
  });

  // 3.5. Tab switching logic
  panel.querySelectorAll('.nr-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      panel.querySelectorAll('.nr-tab-btn').forEach(b => b.classList.remove('active'));
      (e.currentTarget as HTMLElement).classList.add('active');
      
      const viewId = (e.currentTarget as HTMLElement).dataset.view;
      panel.querySelectorAll('.nr-view').forEach(v => v.classList.remove('active'));
      const targetView = panel.querySelector(`#nr-view-${viewId}`);
      if (targetView) targetView.classList.add('active');
    });
  });

  // 3.6 Time Filter Logic
  panel.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      panel.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
      (e.currentTarget as HTMLElement).classList.add('active');
      const range = (e.currentTarget as HTMLElement).dataset.range || 'all';
      
      if (typeof browser !== 'undefined' && browser.storage?.local) {
        await browser.storage.local.set({ timeHorizonFilter: range });
        console.log(`[NextRole] Time Horizon Filter set to: ${range}`);
        renderCareerFeed(panel); // Re-render feed immediately on filter change
      }
    });
  });

  // Append Side Panel
  document.body.appendChild(panel);

  // Trigger initial feed render after DOM is mounted
  requestAnimationFrame(() => renderCareerFeed(panel));

  // Listen for REFRESH_HUD_FEED from background storage broker
  browser.runtime.onMessage.addListener((msg: any) => {
    if (msg.action === 'REFRESH_HUD_FEED') {
      const livePanel = document.getElementById('nextrole-side-panel');
      if (livePanel) renderCareerFeed(livePanel);
    }
  });

  // 4. Load dynamic features & state
  await updatePanelData(panel, currentUrl, company);
  await initArchitectProfile(panel);
}

async function updatePanelData(panel: HTMLElement, currentUrl: string, company: string) {
  const actionContainer = panel.querySelector('#nr-action-container');
  const countSpan = panel.querySelector('#nr-tracked-pages-count');

  if (!actionContainer) return;

  try {
    // Retrieve user storage details safely
    let userId = 'default-user';
    let savedSearches: any[] = [];
    
    try {
      const storage = (await browser.storage.local.get(['userId', 'savedSearches'])) as any;
      userId = storage.userId || 'default-user';
      savedSearches = storage.savedSearches || [];
    } catch (storageErr) {
      console.warn('[NextRole] browser.storage.local not available, using fallbacks:', storageErr);
    }

    // Update total count display
    if (countSpan) {
      countSpan.textContent = `${savedSearches.length} channels online`;
    }

    // ----------------------------------------------------
    // A. RENDER TRACKING STATUS
    // ----------------------------------------------------
    const isTracked = savedSearches.some((s: any) => s.url === currentUrl);

    if (isTracked) {
      actionContainer.innerHTML = `
        <div style="background: rgba(0, 200, 81, 0.04); border: 1px solid rgba(0, 200, 81, 0.25); border-radius: 12px; padding: 14px; text-align: center; display: flex; flex-direction: column; gap: 6px; box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.02);">
          <div style="color: #00c851; font-family: var(--mono); font-weight: 700; font-size: 11.5px; display: flex; align-items: center; justify-content: center; gap: 6px; letter-spacing: 0.5px;">
            <span style="background-color: #00c851; width: 6px; height: 6px; border-radius: 50%; display: inline-block; box-shadow: 0 0 8px #00c851;"></span>
            [ MONITORING STATUS: ACTIVE ]
          </div>
          <p style="font-size: 11px; color: var(--muted); margin: 0; line-height: 1.45;">NextRole is currently auditing this channel in the background. System-level desktop alerts will launch as jobs release.</p>
        </div>
      `;
    } else {
      actionContainer.innerHTML = `
        <button id="nr-track-action-btn" style="width: 100%; background: var(--yellow); border: none; border-radius: 10px; color: #000000; font-family: var(--mono); font-weight: 700; font-size: 12px; padding: 12px; cursor: pointer; transition: all 0.25s ease; box-shadow: 0 4px 14px rgba(240, 255, 0, 0.25); outline: none; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 8px; letter-spacing: 0.5px; margin-top: 4px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14"></path>
            <path d="M12 5v14"></path>
          </svg>
          CONNECT CHANNEL FEED
        </button>
      `;

      // Hook up tracking click listener
      const trackBtn = panel.querySelector('#nr-track-action-btn') as HTMLElement;
      trackBtn?.addEventListener('mouseenter', () => {
        trackBtn.style.transform = 'translateY(-1.5px)';
        trackBtn.style.boxShadow = '0 6px 18px rgba(240, 255, 0, 0.45)';
        trackBtn.style.background = '#ffffff';
      });
      trackBtn?.addEventListener('mouseleave', () => {
        trackBtn.style.transform = 'translateY(0)';
        trackBtn.style.boxShadow = '0 4px 14px rgba(240, 255, 0, 0.25)';
        trackBtn.style.background = 'var(--yellow)';
      });

      trackBtn?.addEventListener('click', async () => {
        trackBtn.setAttribute('disabled', 'true');
        trackBtn.textContent = 'LINKING TERMINAL...';

        try {
          // 1. Sync to local storage safely
          let currentSearches: any[] = [];
          try {
            const currentData = (await browser.storage.local.get('savedSearches')) as any;
            currentSearches = currentData.savedSearches || [];
          } catch (e) {
            console.warn('[NextRole] Could not get savedSearches from storage during click:', e);
          }
          
          const exists = currentSearches.some((s: any) => s.url === currentUrl);
          if (!exists) {
            currentSearches.push({
              id: Date.now().toString(),
              companyName: company,
              url: currentUrl,
              createdAt: Date.now()
            });
            try {
              await browser.storage.local.set({ savedSearches: currentSearches });
            } catch (e) {
              console.warn('[NextRole] Could not save searches to storage during click:', e);
            }
          }

          // 2. Sync to Express PostgreSQL database via background delegation
          try {
            await safeBackendFetch('http://localhost:5000/api/tracked-searches', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-User-Id': userId
              },
              body: {
                url: currentUrl,
                platform: currentUrl.includes('greenhouse.io') 
                  ? 'Greenhouse' 
                  : currentUrl.includes('lever.co') 
                    ? 'Lever' 
                    : currentUrl.includes('myworkdayjobs.com')
                      ? 'Workday'
                      : currentUrl.includes('linkedin.com')
                        ? 'LinkedIn'
                        : 'Custom Board'
              }
            });
          } catch (backendErr) {
            console.warn('[NextRole] Backend offline. Tracked locally only.', backendErr);
          }

          // Success animation update
          trackBtn.style.background = '#00c851';
          trackBtn.style.color = '#ffffff';
          trackBtn.style.boxShadow = '0 4px 14px rgba(0, 200, 81, 0.35)';
          trackBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            [ SECURELY LINKED ]
          `;

          setTimeout(async () => {
            // Re-render complete panel details
            await updatePanelData(panel, currentUrl, company);
          }, 1300);

        } catch (err) {
          console.error('[NextRole] Click track failed:', err);
          trackBtn.removeAttribute('disabled');
          trackBtn.textContent = 'CONNECT CHANNEL FEED';
        }
      });
    }

    // ----------------------------------------------------
    // C. RENDER TAILORED RESUME PREVIEW / DOWNLOAD
    // ----------------------------------------------------
    const resumeContainer = panel.querySelector('#nr-resume-container');
    if (resumeContainer) {
      try {
        const resumeRes = await safeBackendFetch(`http://localhost:5000/api/resumes/lookup?url=${encodeURIComponent(currentUrl)}`, {
          headers: { 'X-User-Id': userId }
        });
        if (resumeRes && resumeRes.success && resumeRes.data) {
          const { snapshot, resume } = resumeRes.data;
          const pdfDownloadUrl = `http://localhost:5000${resume.pdfUrl}`;

          // Render the Holographic Resume Card!
          resumeContainer.innerHTML = `
            <div style="background: linear-gradient(135deg, rgba(139, 92, 246, 0.08) 0%, rgba(99, 102, 241, 0.08) 100%); border: 1.5px solid rgba(139, 92, 246, 0.35); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 8px 24px -8px rgba(139, 92, 246, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.05); position: relative; box-sizing: border-box; width: 100%;">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <span style="font-family: 'Space Grotesk', monospace; font-size: 9px; font-weight: 700; color: #a78bfa; letter-spacing: 0.5px; display: flex; align-items: center; gap: 5px;">
                  <span style="background-color: #a78bfa; width: 6px; height: 6px; border-radius: 50%; display: inline-block; box-shadow: 0 0 8px #a78bfa;"></span>
                  [ ✨ AI TAILORED RESUME READY ]
                </span>
              </div>
              
              <div style="display: flex; flex-direction: column; gap: 2px;">
                <div style="font-size: 12.5px; font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px;">
                  ${escapeHtml(snapshot.title)}
                </div>
                <div style="font-size: 10.5px; color: #94a3b8; display: flex; align-items: center; gap: 4px;">
                  <span>📍 ${escapeHtml(snapshot.location)}</span>
                </div>
              </div>

              <div style="display: flex; gap: 8px; margin-top: 4px;">
                <button id="nr-download-resume-btn" style="flex: 1; background: rgba(139, 92, 246, 0.12); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 8px; color: #c084fc; font-family: 'Space Grotesk', monospace; font-weight: 700; font-size: 10.5px; padding: 8px 10px; cursor: pointer; transition: all 0.2s ease; outline: none; display: flex; align-items: center; justify-content: center; gap: 5px; box-sizing: border-box; height: 32px;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  DOWNLOAD
                </button>
                <button id="nr-preview-resume-btn" style="flex: 1; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; color: #cbd5e1; font-family: 'Space Grotesk', monospace; font-weight: 700; font-size: 10.5px; padding: 8px 10px; cursor: pointer; transition: all 0.2s ease; outline: none; display: flex; align-items: center; justify-content: center; gap: 5px; box-sizing: border-box; height: 32px;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                  PREVIEW
                </button>
              </div>

              <!-- Preview Drawer Content (Hidden initially) -->
              <div id="nr-resume-preview-drawer" style="display: none; max-height: 200px; overflow-y: auto; background: rgba(0, 0, 0, 0.5); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; padding: 10px; margin-top: 6px; font-size: 9.5px; line-height: 1.45; color: #cbd5e1; font-family: monospace; box-sizing: border-box; width: 100%; text-align: left;">
                ${resume.resumeText}
              </div>
            </div>
          `;

          // Action: Download button
          const dlBtn = resumeContainer.querySelector('#nr-download-resume-btn') as HTMLElement;
          dlBtn?.addEventListener('mouseenter', () => {
            dlBtn.style.background = 'rgba(139, 92, 246, 0.2)';
            dlBtn.style.borderColor = 'rgba(139, 92, 246, 0.45)';
          });
          dlBtn?.addEventListener('mouseleave', () => {
            dlBtn.style.background = 'rgba(139, 92, 246, 0.12)';
            dlBtn.style.borderColor = 'rgba(139, 92, 246, 0.3)';
          });
          dlBtn?.addEventListener('click', () => {
            if (typeof browser !== 'undefined' && browser.runtime?.id) {
              browser.runtime.sendMessage({ action: 'openTab', url: pdfDownloadUrl });
            }
          });

          // Action: Preview button toggling
          const prvBtn = resumeContainer.querySelector('#nr-preview-resume-btn') as HTMLElement;
          const drawer = resumeContainer.querySelector('#nr-resume-preview-drawer') as HTMLElement;
          prvBtn?.addEventListener('mouseenter', () => {
            prvBtn.style.background = 'rgba(255, 255, 255, 0.06)';
            prvBtn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
          });
          prvBtn?.addEventListener('mouseleave', () => {
            prvBtn.style.background = 'rgba(255, 255, 255, 0.02)';
            prvBtn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
          });
          prvBtn?.addEventListener('click', () => {
            if (drawer.style.display === 'none') {
              drawer.style.display = 'block';
              prvBtn.textContent = 'HIDE';
              prvBtn.style.color = '#a78bfa';
              prvBtn.style.borderColor = 'rgba(139, 92, 246, 0.3)';
            } else {
              drawer.style.display = 'none';
              prvBtn.textContent = 'PREVIEW';
              prvBtn.style.color = '#cbd5e1';
              prvBtn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
            }
          });

        } else {
          // Fallback default info notice
          resumeContainer.innerHTML = `
            <div style="background: rgba(139, 92, 246, 0.04); border: 1px dashed rgba(139, 92, 246, 0.18); border-radius: 10px; padding: 11px 13px; font-size: 11px; color: var(--muted); line-height: 1.45; display: flex; flex-direction: column; gap: 3px; box-sizing: border-box; width: 100%;">
              <strong style="color: #cbd5e1; font-family: var(--mono); font-size: 11px; letter-spacing: 0.2px;">💡 AUTOMATED ATS COMPILER</strong>
              <span>Navigate into any distinct job listing detail page. Co-pilot will automatically compile a tailored A4 PDF resume!</span>
            </div>
          `;
        }
      } catch (err) {
        console.warn('[NextRole] Resume lookup failed:', err);
      }
    }
  } catch (err) {
    console.error('[NextRole] Fatal error in updatePanelData:', err);
  }
}

function injectFloatingTrigger() {
  if (document.getElementById('nextrole-side-trigger')) {
    const existing = document.getElementById('nextrole-side-trigger');
    if (existing) {
      existing.style.transform = 'scale(1) translateY(0)';
      existing.style.opacity = '1';
      existing.style.pointerEvents = 'auto';
    }
    return;
  }

  const trigger = document.createElement('button');
  trigger.id = 'nextrole-side-trigger';
  trigger.innerHTML = `
    <div style="background: rgba(3, 7, 18, 0.85); width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 15px rgba(6, 182, 212, 0.4); border: 1.5px solid rgba(6, 182, 212, 0.4); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); box-sizing: border-box; backdrop-filter: blur(8px); webkit-backdrop-filter: blur(8px);">
      <svg class="nr-side-logo-spin" style="width: 18px; height: 18px;" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" />
        <polyline points="12 2 12 22" />
        <polyline points="12 12 22 8.5" />
        <polyline points="12 12 2 8.5" />
      </svg>
    </div>
  `;

  Object.assign(trigger.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: '2147483647',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    outline: 'none',
    padding: '0',
    boxSizing: 'border-box',
  });

  trigger.addEventListener('mouseenter', () => {
    const bubble = trigger.querySelector('div') as HTMLElement;
    if (bubble) {
      bubble.style.transform = 'scale(1.1) translateY(-2px)';
      bubble.style.boxShadow = '0 0 22px rgba(6, 182, 212, 0.7)';
      bubble.style.borderColor = '#06b6d4';
    }
  });

  trigger.addEventListener('mouseleave', () => {
    const bubble = trigger.querySelector('div') as HTMLElement;
    if (bubble) {
      bubble.style.transform = 'scale(1) translateY(0)';
      bubble.style.boxShadow = '0 0 15px rgba(6, 182, 212, 0.4)';
      bubble.style.borderColor = 'rgba(6, 182, 212, 0.4)';
    }
  });

  trigger.addEventListener('click', () => {
    safeSetDismissedState(false);
    const panel = document.getElementById('nextrole-side-panel');
    if (panel) {
      panel.style.transform = 'translateX(0)';
      panel.style.opacity = '1';
      panel.style.pointerEvents = 'auto';
    }
    
    // Hide the launcher trigger
    trigger.style.transform = 'scale(0) translateY(10px)';
    trigger.style.opacity = '0';
    trigger.style.pointerEvents = 'none';
  });

  document.body.appendChild(trigger);
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ----------------------------------------------------
// LINKEDIN VIRTUAL LIST SCRAPER & STREAMING PIPELINE
// ----------------------------------------------------

let linkedInObserver: MutationObserver | null = null;
const seenJobIds = new Set<string>();

const INDIAN_METRO_MAP: Record<string, string[]> = {
  "delhi / ncr": ["delhi", "ncr", "gurgaon", "gurugram", "noida", "ghaziabad", "faridabad", "haryana", "uttar pradesh"],
  "bengaluru": ["bengaluru", "bangalore", "electronic city", "whitefield", "karnataka"],
  "hyderabad": ["hyderabad", "secunderabad", "gachibowli", "hitech city", "telangana"],
  "mumbai / pune": ["mumbai", "pune", "thane", "navi mumbai", "hinjewadi", "maharashtra"],
  "chennai": ["chennai", "madras", "siruseri", "omr", "tamil nadu"]
};

function escapeRegex(string: string): string {
  return string.replace(/[/-\^$*+?.()|[]{}]/g, '\\$&');
}

function safeBtoa(str: string): string {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    return Math.random().toString(36).substring(2, 15);
  }
}

async function evaluateJobLocally(scrapedJob: { title: string; company: string; location: string; rawTime: string; url: string }) {
  try {
    const storage = await browser.storage.local.get(['targetRoles', 'targetLocations', 'activeTimeHorizon']) as any;
    const targetRoles = storage.targetRoles || [];
    const targetLocations = storage.targetLocations || [];
    const activeTimeHorizon = storage.activeTimeHorizon || 'all';

    // STEP A: Role Validation (Regex-driven)
    if (targetRoles && targetRoles.length > 0) {
      const matchesAnyRole = targetRoles.some((role: string) => {
        if (!role.trim()) return false;
        const regex = new RegExp('\\b' + escapeRegex(role.trim()) + '\\b', 'i');
        return regex.test(scrapedJob.title);
      });
      if (!matchesAnyRole) return null;
    }

    // STEP B: Indian Multi-Location Heuristic
    let locationPassed = false;
    try {
      const normLoc = (scrapedJob.location || '').toLowerCase().trim();
      
      if (normLoc.includes('remote') || normLoc.includes('work from home')) {
        locationPassed = true;
      } else if (targetLocations && targetLocations.length > 0) {
        for (const targetLoc of targetLocations) {
          const key = targetLoc.toLowerCase().trim();
          const aliases = INDIAN_METRO_MAP[key] || [key];
          if (aliases.some(alias => normLoc.includes(alias.toLowerCase().trim()))) {
            locationPassed = true;
            break;
          }
        }
      } else {
        // If no locations are selected, default to pass all locations (no strict local city constraints applied)
        locationPassed = true;
      }
    } catch (locErr) {
      console.warn('[NextRole] Location heuristic matching error:', locErr);
      locationPassed = false;
    }

    if (!locationPassed) return null;

    // STEP C: Time Horizon Matrix Conversion
    let mappedHorizon = 'older';
    const ts = scrapedJob.rawTime.toLowerCase();
    if (ts.includes('hour') || ts.includes('minute') || ts.includes('second') || ts.includes('now') || ts.includes('just now')) {
      mappedHorizon = 'today';
    } else if (ts.includes('day')) {
      const match = ts.match(/(\\d+)/);
      if (match) {
        const days = parseInt(match[1], 10);
        if (!isNaN(days) && days <= 7) {
          mappedHorizon = 'week';
        }
      }
    }

    if (activeTimeHorizon === 'today') {
      if (mappedHorizon !== 'today') return null;
    } else if (activeTimeHorizon === 'week') {
      if (mappedHorizon !== 'today' && mappedHorizon !== 'week') return null;
    }

    const passedJob = {
      title: scrapedJob.title,
      company: scrapedJob.company,
      location: scrapedJob.location,
      timeHorizon: mappedHorizon,
      url: scrapedJob.url,
      rawTime: scrapedJob.rawTime
    };

    // Construct a secure local unique ID string combining btoa(title-company)
    const signature = `${passedJob.title}-${passedJob.company}`;
    const uniqueId = safeBtoa(signature);

    // Check local seenJobIds cache
    if (seenJobIds.has(uniqueId)) return null;
    seenJobIds.add(uniqueId);

    // Completely fresh, update local storage scrapedJobs
    const localStore = await browser.storage.local.get('scrapedJobs') as any;
    const existingJobs: any[] = localStore.scrapedJobs || [];
    
    // Append to front, slice to 100 entries maximum
    const updatedJobs = [{ ...passedJob, id: uniqueId }, ...existingJobs].slice(0, 100);
    await browser.storage.local.set({ scrapedJobs: updatedJobs });

    console.log(`[NextRole] Local Match Validated: "${passedJob.title}" at "${passedJob.company}"`);

    // Execute local runtime message broadcast to trigger immediate re-render
    if (typeof browser !== 'undefined' && browser.runtime?.id) {
      browser.runtime.sendMessage({ action: "REFRESH_HUD_FEED" }).catch(() => {});
    }

    return passedJob;
  } catch (err) {
    console.warn('[NextRole] Local job evaluation failed:', err);
    return null;
  }
}

function startLinkedInScraper() {
  if (linkedInObserver) return; // Already running
  
  // Only activate on LinkedIn search pages
  if (!window.location.href.includes('linkedin.com/jobs/search')) return;

  const targetNode = document.body;
  
  linkedInObserver = new MutationObserver(() => {
    // LinkedIn changes class names occasionally, so we target the list containers robustly
    const listItems = document.querySelectorAll('.scaffold-layout__list-item, .jobs-search-results__list li');
    if (!listItems.length) return;

    listItems.forEach(item => {
      try {
        const titleEl = item.querySelector('.job-card-list__title') as HTMLElement;
        const companyEl = item.querySelector('.job-card-list__company-name') as HTMLElement;
        const timeEl = item.querySelector('.job-card-container__metadata-item--secondary, time, [class*="metadata-item--secondary"]') as HTMLElement;
        const linkEl = item.querySelector('a.job-card-list__title, a[href*="/jobs/view/"]') as HTMLAnchorElement;
        const locEl = item.querySelector('.job-card-container__metadata-item, .job-card-list__metadata-item, .job-card-container__metadata-wrapper li, [class*="metadata-item"]') as HTMLElement;
        
        if (!titleEl || !companyEl) return;
        
        const title = titleEl.textContent?.trim() || '';
        const company = companyEl.textContent?.trim() || '';
        const rawTime = timeEl?.textContent?.trim() || '';
        const location = locEl?.textContent?.trim() || '';
        const url = linkEl?.href || window.location.href;

        evaluateJobLocally({ title, company, location, rawTime, url });
      } catch (err) {
        // Fail silently for individual nodes to prevent infinite scroll crashing
      }
    });
  });

  linkedInObserver.observe(targetNode, { childList: true, subtree: true });
}

// ----------------------------------------------------
// DYNAMIC HUD FEED RENDERER
// ----------------------------------------------------

async function renderCareerFeed(panel: HTMLElement) {
  const feedContainer = panel.querySelector('#nr-feed-list');
  if (!feedContainer) return;

  try {
    const storage = (await browser.storage.local.get(['scrapedJobs', 'activeTimeHorizon'])) as any;
    const allJobs: any[] = storage.scrapedJobs || [];
    const activeFilter: string = storage.activeTimeHorizon || 'all';

    // Apply time horizon filter
    const filteredJobs = allJobs.filter((job: any) => {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'today') return job.timeHorizon === 'today';
      if (activeFilter === 'week') return job.timeHorizon === 'today' || job.timeHorizon === 'week';
      return true;
    });

    // Update footer count
    const countEl = panel.querySelector('#nr-tracked-pages-count');
    if (countEl) countEl.textContent = `${allJobs.length} signals cached`;

    // Empty state
    if (filteredJobs.length === 0) {
      feedContainer.innerHTML = `
        <div class="terminal-alert">
          // NO TRACKED STREAM ALIGNED TO MATRIX<br><br>
          <span style="color: var(--cyan); font-size: 9px;">[ Navigate to a LinkedIn Jobs search to begin scanning ]</span>
        </div>
      `;
      return;
    }

    // Compile cards
    feedContainer.innerHTML = filteredJobs.map((job: any) => {
      const tagClass = job.timeHorizon === 'today' ? 'today' : job.timeHorizon === 'week' ? 'week' : '';
      const tagLabel = job.timeHorizon === 'today' ? '⚡ TODAY' : job.timeHorizon === 'week' ? '📅 THIS WEEK' : '🗂️ OLDER';
      const safeTitle = escapeHtml(job.title || 'Untitled Role');
      const safeCompany = escapeHtml(job.company || 'Unknown');
      const safeUrl = escapeHtml(job.url || '#');

      return `
        <div class="nr-feed-card">
          <div class="nr-feed-card-title">${safeTitle}</div>
          <div class="nr-feed-card-meta">
            <span>🏢 ${safeCompany}</span>
            <span class="nr-feed-card-tag ${tagClass}">${tagLabel}</span>
          </div>
          <button class="nr-feed-btn" onclick="window.open('${safeUrl}', '_blank')">▸ COMPILE ATS RESUME</button>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.warn('[NextRole] Feed render failed:', err);
    feedContainer.innerHTML = `<div class="terminal-alert">// FEED RENDER ERROR - RETRYING...</div>`;
  }
}


// ----------------------------------------------------
// ARCHITECT PROFILE STORAGE MATRIX & INTERACTIVE CONTROLLERS
// ----------------------------------------------------

interface MasterProfile {
  fullName: string;
  education: {
    institution: string;
    degree: string;
    specialization: string;
    graduationYear: string;
  };
  skills: {
    languages: string[];
    frameworks: string[];
    databases: string[];
    specializedTech: string[];
  };
  coreProjects: Array<{
    name: string;
    description: string;
    techStack: string[];
  }>;
}

function sanitizeString(str: string): string {
  if (!str) return '';
  return str.replace(/<script[^>]*>([\S\s]*?)<\/script>/gi, '')
            .replace(/<\/?[^>]+(>|$)/g, '');
}

async function initArchitectProfile(panel: HTMLElement) {
  let profile: MasterProfile = {
    fullName: '',
    education: { institution: '', degree: '', specialization: '', graduationYear: '' },
    skills: { languages: [], frameworks: [], databases: [], specializedTech: [] },
    coreProjects: []
  };

  // Load from storage
  try {
    const storage = await browser.storage.local.get('masterProfile') as any;
    if (storage.masterProfile) {
      profile = storage.masterProfile;
    }
  } catch (e) {
    console.warn('[NextRole] Error reading masterProfile:', e);
  }

  // Bind values
  const nameInput = panel.querySelector('#nr-profile-fullname') as HTMLInputElement;
  const instInput = panel.querySelector('#nr-profile-institution') as HTMLInputElement;
  const degInput = panel.querySelector('#nr-profile-degree') as HTMLInputElement;
  const specInput = panel.querySelector('#nr-profile-specialization') as HTMLInputElement;
  const gradInput = panel.querySelector('#nr-profile-gradyear') as HTMLInputElement;
  const saveStatus = panel.querySelector('#nr-profile-save-status') as HTMLElement;
  const commitBtn = panel.querySelector('#nr-btn-save-profile') as HTMLButtonElement;

  if (nameInput) nameInput.value = profile.fullName || '';
  if (instInput) instInput.value = profile.education?.institution || '';
  if (degInput) degInput.value = profile.education?.degree || '';
  if (specInput) specInput.value = profile.education?.specialization || '';
  if (gradInput) gradInput.value = profile.education?.graduationYear || '';

  // Render Skill Tags
  const categories = ['languages', 'frameworks', 'databases', 'specializedTech'] as const;
  categories.forEach(cat => {
    renderTags(cat);
    setupTagInput(cat);
  });

  // Render Projects
  renderProjects();

  // Setup Add Project button
  const addProjBtn = panel.querySelector('#nr-btn-add-project');
  addProjBtn?.addEventListener('click', () => {
    if (!profile.coreProjects) profile.coreProjects = [];
    profile.coreProjects.push({ name: '', description: '', techStack: [] });
    renderProjects();
    triggerSave(true);
  });

  // Dynamic Tags rendering helper
  function renderTags(cat: typeof categories[number]) {
    const container = panel.querySelector(`#nr-tags-${cat}`);
    if (!container) return;
    const tagList = profile.skills[cat] || [];
    container.innerHTML = tagList.map((tag, idx) => `
      <span class="nr-tag" data-category="${cat}" data-index="${idx}">
        ${escapeHtml(tag)}
        <span class="nr-tag-del" data-category="${cat}" data-index="${idx}">×</span>
      </span>
    `).join('');

    // Setup delete listeners
    container.querySelectorAll('.nr-tag-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt((e.currentTarget as HTMLElement).dataset.index || '0', 10);
        profile.skills[cat].splice(index, 1);
        renderTags(cat);
        triggerSave(true);
      });
    });
  }

  // Setup Skill inputs
  function setupTagInput(cat: typeof categories[number]) {
    const input = panel.querySelector(`#nr-input-${cat}`) as HTMLInputElement;
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = sanitizeString(input.value.trim());
        if (val) {
          if (!profile.skills[cat]) profile.skills[cat] = [];
          if (!profile.skills[cat].includes(val)) {
            profile.skills[cat].push(val);
          }
          input.value = '';
          renderTags(cat);
          triggerSave(true);
        }
      }
    });
  }

  // Dynamic Projects rendering helper
  function renderProjects() {
    const container = panel.querySelector('#nr-projects-container');
    if (!container) return;
    const projectList = profile.coreProjects || [];
    container.innerHTML = projectList.map((p, idx) => `
      <div class="nr-project-card" data-index="${idx}">
        <button class="nr-close-btn nr-del-project-btn" data-index="${idx}" style="top: 6px; right: 6px; position: absolute; background: none; border: none; color: var(--muted); cursor: pointer;">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
        <div class="nr-form-group">
          <label>PROJECT NAME</label>
          <input type="text" class="nr-input nr-project-name" data-index="${idx}" value="${escapeHtml(p.name || '')}" placeholder="e.g. NextRole Core Engine">
        </div>
        <div class="nr-form-group">
          <label>TECH STACK (COMMA SEPARATED)</label>
          <input type="text" class="nr-input nr-project-tech" data-index="${idx}" value="${escapeHtml((p.techStack || []).join(', '))}" placeholder="e.g. React, Node.js, WebSockets">
        </div>
        <div class="nr-form-group">
          <label>TECHNICAL DESCRIPTION</label>
          <textarea class="nr-textarea nr-project-desc" data-index="${idx}" placeholder="Deep bullet points on system design/performance...">${escapeHtml(p.description || '')}</textarea>
        </div>
      </div>
    `).join('');

    // Setup input listeners on project cards
    container.querySelectorAll('.nr-project-name').forEach(input => {
      input.addEventListener('input', (e) => {
        const idx = parseInt((e.target as HTMLInputElement).dataset.index || '0', 10);
        profile.coreProjects[idx].name = sanitizeString((e.target as HTMLInputElement).value);
        triggerSave(false);
      });
    });

    container.querySelectorAll('.nr-project-tech').forEach(input => {
      input.addEventListener('input', (e) => {
        const idx = parseInt((e.target as HTMLInputElement).dataset.index || '0', 10);
        profile.coreProjects[idx].techStack = (e.target as HTMLInputElement).value
          .split(',')
          .map(t => sanitizeString(t.trim()))
          .filter(t => t);
        triggerSave(false);
      });
    });

    container.querySelectorAll('.nr-project-desc').forEach(textarea => {
      textarea.addEventListener('input', (e) => {
        const idx = parseInt((e.target as HTMLTextAreaElement).dataset.index || '0', 10);
        profile.coreProjects[idx].description = sanitizeString((e.target as HTMLTextAreaElement).value);
        triggerSave(false);
      });
    });

    // Delete project listeners
    container.querySelectorAll('.nr-del-project-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt((e.currentTarget as HTMLElement).dataset.index || '0', 10);
        profile.coreProjects.splice(idx, 1);
        renderProjects();
        triggerSave(true);
      });
    });
  }

  // Input listeners on main fields
  [nameInput, instInput, degInput, specInput, gradInput].forEach(el => {
    el?.addEventListener('input', () => {
      profile.fullName = sanitizeString(nameInput?.value || '');
      profile.education = {
        institution: sanitizeString(instInput?.value || ''),
        degree: sanitizeString(degInput?.value || ''),
        specialization: sanitizeString(specInput?.value || ''),
        graduationYear: sanitizeString(gradInput?.value || '')
      };
      triggerSave(false);
    });
  });

  // Debounced auto-save (300ms)
  let saveTimeout: any;
  function triggerSave(immediate = false) {
    if (saveStatus) saveStatus.textContent = '[ STATUS: WRITING... ]';
    if (saveTimeout) clearTimeout(saveTimeout);
    
    if (immediate) {
      saveProfile();
    } else {
      saveTimeout = setTimeout(saveProfile, 300);
    }
  }

  async function saveProfile() {
    try {
      await browser.storage.local.set({ masterProfile: profile });
      if (saveStatus) saveStatus.textContent = '[ STATUS: DATA SYNCED ]';
      
      // Fire update alert broadcast
      if (typeof browser !== 'undefined' && browser.runtime?.id) {
        browser.runtime.sendMessage({ action: "MASTER_PROFILE_MUTATED" }).catch(() => {});
      }
    } catch (e) {
      console.error('[NextRole] Auto-save profile failed:', e);
      if (saveStatus) saveStatus.textContent = '[ STATUS: SYNC ERROR ]';
    }
  }

  // Save button action
  commitBtn?.addEventListener('click', async () => {
    commitBtn.style.borderColor = '#00c851';
    commitBtn.style.color = '#00c851';
    commitBtn.style.background = 'rgba(0, 200, 81, 0.1)';
    commitBtn.textContent = '// SYSTEM MATRIX MUTATED';
    
    await saveProfile();

    setTimeout(() => {
      commitBtn.style.borderColor = 'var(--cyan)';
      commitBtn.style.color = 'var(--cyan)';
      commitBtn.style.background = 'rgba(0, 240, 255, 0.1)';
      commitBtn.textContent = '// COMMIT MASTER SYSTEM MATRIX';
    }, 2000);
  });
}
