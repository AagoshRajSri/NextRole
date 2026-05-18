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
      console.log('[NextRole] Content script context invalidated. MutationObserver disconnected.');
    });

    // Also listen for standard popstate browser navigation events using the WXT context listener
    ctx.addEventListener(window, 'popstate', () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        handleDetection();
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

async function handleDetection() {
  const isCareerPage = detectCareerPage();

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
      
      const isDismissed = sessionStorage.getItem('nextrole-panel-dismissed') === 'true';
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
      
      if (sessionStorage.getItem('nextrole-panel-dismissed') === 'true') {
        injectFloatingTrigger();
      }
    }
  } else {
    // If the user navigates away from a career portal, slide the side panel out of view automatically!
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

function detectCareerPage(): boolean {
  const url = window.location.href.toLowerCase();

  // 1. Hardcoded check for the 3 target platforms
  if (
    url.includes('myworkdayjobs.com') ||
    url.includes('boards.greenhouse.io') ||
    url.includes('jobs.lever.co')
  ) {
    return true;
  }

  // 2. Common career portal sub-paths in URL (LinkedIn jobs, /careers dashboards, etc)
  if (
    url.includes('/careers') ||
    url.includes('/jobs') ||
    url.includes('/careers/') ||
    url.includes('/join-us') ||
    url.includes('/careers-at')
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
  
  // Clean up title as fallback
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
  const isDismissed = sessionStorage.getItem('nextrole-panel-dismissed') === 'true';

  // 1. Create Panel Element container
  const panel = document.createElement('div');
  panel.id = 'nextrole-side-panel';
  
  panel.innerHTML = `
    <!-- Top Cyber Accent Line -->
    <div style="height: 4px; background: linear-gradient(90deg, #8b5cf6 0%, #06b6d4 100%);"></div>
    
    <!-- Translucent Grid Overlay -->
    <div style="position: absolute; top:0; left:0; width:100%; height:100%; background-image: linear-gradient(rgba(6, 182, 212, 0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(6, 182, 212, 0.02) 1px, transparent 1px); background-size: 15px 15px; pointer-events: none; z-index: 0;"></div>

    <style>
      @keyframes logo-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .nr-side-logo-spin {
        animation: logo-spin 15s linear infinite;
      }
    </style>
    
    <div style="padding: 24px; display: flex; flex-direction: column; gap: 20px; height: 100%; box-sizing: border-box; position: relative; z-index: 1;">
      <!-- Header HUD -->
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="background: rgba(6, 182, 212, 0.08); width: 26px; height: 26px; border-radius: 6px; display: flex; align-items: center; justify-content: center; border: 1px solid rgba(6, 182, 212, 0.25); box-shadow: 0 0 8px rgba(6, 182, 212, 0.15);">
            <svg class="nr-side-logo-spin" style="width: 14px; height: 14px;" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" />
              <polyline points="12 2 12 22" />
              <polyline points="12 12 22 8.5" />
              <polyline points="12 12 2 8.5" />
            </svg>
          </div>
          <div style="display: flex; flex-direction: column; gap: 1px;">
            <span style="font-family: 'Space Grotesk', monospace; font-weight: 700; font-size: 13.5px; letter-spacing: 0.5px; background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">NEXTROLE</span>
            <span style="font-family: 'Space Grotesk', monospace; font-size: 7.5px; color: #06b6d4; font-weight: 700; letter-spacing: 0.5px;">// CO-PILOT.v1.0</span>
          </div>
        </div>
        <button id="nr-close-panel" style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); color: #94a3b8; cursor: pointer; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; transition: all 0.2s ease; outline: none; padding: 0;">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <!-- Company Details HUD -->
      <div style="background: rgba(6, 182, 212, 0.04); border: 1px solid rgba(6, 182, 212, 0.15); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px;">
        <span style="font-family: 'Space Grotesk', monospace; font-size: 8px; font-weight: 700; text-transform: uppercase; color: #06b6d4; letter-spacing: 0.8px;">// CAREER FEED ACTIVE</span>
        <div style="font-size: 13.5px; font-weight: 700; color: #ffffff; display: flex; align-items: center; gap: 6px;">
          <span>🏢</span> <span id="nr-company-display" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px;">${company}</span>
        </div>
      </div>

      <!-- Action Tracking Module -->
      <div id="nr-action-container" style="transition: all 0.3s ease;">
        <div style="color: #94a3b8; text-align: center; font-size: 11px; font-family: 'Space Grotesk', monospace;">[ CONNECTING TO DATABASE NODE... ]</div>
      </div>

      <!-- Premium HUD Panel -->
      <div id="nr-premium-container" style="background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px; font-size: 11.5px; transition: all 0.3s ease;">
        <div style="color: #94a3b8; font-family: 'Space Grotesk', monospace; font-size: 10px;">[ SUBSCRIPTION: SYNCING ]</div>
      </div>

      <!-- Technical Resume Optimization Notice -->
      <div style="background: rgba(139, 92, 246, 0.04); border: 1px dashed rgba(139, 92, 246, 0.18); border-radius: 10px; padding: 11px 13px; font-size: 11px; color: #94a3b8; line-height: 1.45; display: flex; flex-direction: column; gap: 3px;">
        <strong style="color: #cbd5e1; font-family: 'Space Grotesk', monospace; font-size: 11px; letter-spacing: 0.2px;">💡 AUTOMATED ATS COMPILER</strong>
        <span>Navigate into any distinct job listing detail page. Co-pilot will automatically compile an tailored A4 PDF resume!</span>
      </div>

      <!-- Footer HUD -->
      <div style="margin-top: auto; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 14px; display: flex; align-items: center; justify-content: space-between; font-size: 10.5px; color: #94a3b8; font-family: 'Space Grotesk', monospace;">
        <span style="display: flex; align-items: center; gap: 6px;"><span style="background-color: #06b6d4; width: 5px; height: 5px; border-radius: 50%; display: inline-block;"></span>[ SECURE SYSTEM ]</span>
        <span id="nr-tracked-pages-count">0 channels online</span>
      </div>
    </div>
  `;

  // 2. Set Side Panel styling using dark futuristic glassmorphism themes
  Object.assign(panel.style, {
    position: 'fixed',
    top: '24px',
    right: '24px',
    width: '310px',
    height: 'calc(100vh - 48px)',
    zIndex: '2147483647',
    background: 'rgba(3, 7, 18, 0.88)',
    border: '1px solid rgba(6, 182, 212, 0.2)', // Glowing cyber-accent thin border
    borderRadius: '16px',
    boxShadow: '0 25px 60px -15px rgba(6, 182, 212, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
    fontFamily: '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif',
    transition: 'all 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
    backdropFilter: 'blur(20px)',
    webkitBackdropFilter: 'blur(20px)',
    overflow: 'hidden',
    transform: isDismissed ? 'translateX(360px)' : 'translateX(0)',
    opacity: isDismissed ? '0' : '1',
    pointerEvents: isDismissed ? 'none' : 'auto',
    boxSizing: 'border-box',
  });

  // 3. Close panel event action
  const closeBtn = panel.querySelector('#nr-close-panel') as HTMLElement;
  closeBtn?.addEventListener('click', () => {
    sessionStorage.setItem('nextrole-panel-dismissed', 'true');
    panel.style.transform = 'translateX(360px)';
    panel.style.opacity = '0';
    panel.style.pointerEvents = 'none';
    
    // Inject the launcher button trigger in the corner
    injectFloatingTrigger();
  });

  // Close button hover animations
  closeBtn?.addEventListener('mouseenter', () => {
    closeBtn.style.color = '#ffffff';
    closeBtn.style.background = 'rgba(255, 255, 255, 0.06)';
  });
  closeBtn?.addEventListener('mouseleave', () => {
    closeBtn.style.color = '#94a3b8';
    closeBtn.style.background = 'rgba(255,255,255,0.02)';
  });

  // Append Side Panel
  document.body.appendChild(panel);

  // 4. Load dynamic features & state
  await updatePanelData(panel, currentUrl, company);
}

async function updatePanelData(panel: HTMLElement, currentUrl: string, company: string) {
  const actionContainer = panel.querySelector('#nr-action-container');
  const premiumContainer = panel.querySelector('#nr-premium-container');
  const countSpan = panel.querySelector('#nr-tracked-pages-count');

  if (!actionContainer || !premiumContainer) return;

  // Retrieve user storage details
  const storage = (await browser.storage.local.get(['userId', 'savedSearches'])) as any;
  const userId = storage.userId || 'default-user';
  const savedSearches = storage.savedSearches || [];

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
      <div style="background: rgba(16, 185, 129, 0.05); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 12px; padding: 14px; text-align: center; display: flex; flex-direction: column; gap: 6px; box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.02);">
        <div style="color: #10b981; font-family: 'Space Grotesk', monospace; font-weight: 700; font-size: 12.5px; display: flex; align-items: center; justify-content: center; gap: 6px; letter-spacing: 0.2px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          [ MONITORING STATUS: ACTIVE ]
        </div>
        <p style="font-size: 11px; color: #94a3b8; margin: 0; line-height: 1.45;">NextRole is currently auditing this channel in the background. System-level desktop alerts will launch as jobs release.</p>
      </div>
    `;
  } else {
    actionContainer.innerHTML = `
      <button id="nr-track-action-btn" style="width: 100%; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); border: none; border-radius: 10px; color: #ffffff; font-family: 'Space Grotesk', monospace; font-weight: 700; font-size: 12.5px; padding: 12px; cursor: pointer; transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1); box-shadow: 0 4px 14px rgba(99, 102, 241, 0.35); outline: none; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 8px; letter-spacing: 0.5px;">
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
      trackBtn.style.boxShadow = '0 6px 18px rgba(99, 102, 241, 0.5)';
      trackBtn.style.background = 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)';
    });
    trackBtn?.addEventListener('mouseleave', () => {
      trackBtn.style.transform = 'translateY(0)';
      trackBtn.style.boxShadow = '0 4px 14px rgba(99, 102, 241, 0.35)';
      trackBtn.style.background = 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)';
    });

    trackBtn?.addEventListener('click', async () => {
      trackBtn.setAttribute('disabled', 'true');
      trackBtn.textContent = 'LINKING TERMINAL...';

      try {
        // 1. Sync to local storage
        const currentData = (await browser.storage.local.get('savedSearches')) as any;
        const currentSearches = currentData.savedSearches || [];
        const exists = currentSearches.some((s: any) => s.url === currentUrl);
        if (!exists) {
          currentSearches.push({
            id: Date.now().toString(),
            companyName: company,
            url: currentUrl,
            createdAt: Date.now()
          });
          await browser.storage.local.set({ savedSearches: currentSearches });
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
        trackBtn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
        trackBtn.style.boxShadow = '0 4px 14px rgba(16, 185, 129, 0.35)';
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
  // B. RENDER PREMIUM SUBSCRIPTION MODULE
  // ----------------------------------------------------
  let isPremium = false;
  try {
    const subRes = await safeBackendFetch('http://localhost:5000/api/subscription', {
      headers: { 'X-User-Id': userId }
    });
    if (subRes && subRes.success && subRes.data) {
      isPremium = subRes.data.isActive;
    }
  } catch (e) {
    console.warn('[NextRole] Backend subscription sync offline.');
  }

  if (isPremium) {
    premiumContainer.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        <div style="background: rgba(6, 182, 212, 0.1); color: #06b6d4; font-weight: 700; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; border: 1px solid rgba(6, 182, 212, 0.25);">★</div>
        <div style="display: flex; flex-direction: column; gap: 1px;">
          <span style="font-weight: 700; color: #06b6d4; font-family: 'Space Grotesk', monospace; font-size: 11px;">[ CORE TIER: PREMIUM ]</span>
          <span style="font-size: 10.5px; color: #94a3b8;">Claude optimization nodes are online.</span>
        </div>
      </div>
    `;
  } else {
    premiumContainer.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="background: rgba(245, 158, 11, 0.08); color: #f59e0b; font-weight: 700; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; border: 1px solid rgba(245, 158, 11, 0.2);">★</div>
          <div style="display: flex; flex-direction: column; gap: 1px;">
            <span style="font-weight: 700; color: #f59e0b; font-family: 'Space Grotesk', monospace; font-size: 11px;">[ CO-PILOT: FREE MODULE ]</span>
            <span style="font-size: 10px; color: #94a3b8;">ATS keyword mapping is locked.</span>
          </div>
        </div>
        
        <button id="nr-upgrade-action-btn" style="background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.2); border-radius: 8px; color: #f59e0b; font-family: 'Space Grotesk', monospace; font-size: 10.5px; font-weight: 700; padding: 7px; cursor: pointer; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); outline: none; margin-top: 4px; display: flex; align-items: center; justify-content: center; gap: 4px; box-sizing: border-box; width: 100%; letter-spacing: 0.2px;">
          UPGRADE MODULE ($15/MO)
        </button>
      </div>
    `;

    // Hook up upgrade payments click listener
    const upgradeBtn = panel.querySelector('#nr-upgrade-action-btn') as HTMLElement;
    upgradeBtn?.addEventListener('mouseenter', () => {
      upgradeBtn.style.background = 'rgba(245, 158, 11, 0.12)';
      upgradeBtn.style.borderColor = 'rgba(245, 158, 11, 0.35)';
    });
    upgradeBtn?.addEventListener('mouseleave', () => {
      upgradeBtn.style.background = 'rgba(245, 158, 11, 0.06)';
      upgradeBtn.style.borderColor = 'rgba(245, 158, 11, 0.2)';
    });

    upgradeBtn?.addEventListener('click', async () => {
      upgradeBtn.setAttribute('disabled', 'true');
      upgradeBtn.textContent = 'BOOTING STRIPE GATEWAY...';

      try {
        const checkRes = await safeBackendFetch('http://localhost:5000/api/checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': userId
          }
        });
        
        if (checkRes && checkRes.success && checkRes.data) {
          const data = checkRes.data;
          if (data.url) {
            // Open mock Stripe activation in a new tab directly through message delegator
            if (typeof browser !== 'undefined' && browser.runtime?.id) {
              await browser.runtime.sendMessage({ action: 'openTab', url: data.url });
            }

            // In simulated payments mode, refresh panel status in 1 second to instantly activate!
            if (data.url.includes('mock-success-premium-activated')) {
              setTimeout(async () => {
                await updatePanelData(panel, currentUrl, company);
              }, 1200);
            }
          }
        }
      } catch (err) {
        console.error('[NextRole] Stripe redirect failed:', err);
        upgradeBtn.removeAttribute('disabled');
        upgradeBtn.textContent = 'UPGRADE MODULE ($15/MO)';
      }
    });
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
    sessionStorage.removeItem('nextrole-panel-dismissed');
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
