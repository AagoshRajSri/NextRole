export default defineBackground(() => {
  console.log('[NextRole] Service worker initialized. Starting background polling loop...');

  // Map to store job URLs dynamically linked to notification IDs
  const notificationUrls = new Map<string, string>();

  // Poll interval (every 30 seconds for immediate responsiveness in local testing)
  const POLL_INTERVAL = 30 * 1000;
  
  const CAREER_KEYWORDS = ["jobs", "careers", "positions", "postings", "openings", "join-us"];

  // Global Route Discovery Listener (High Efficiency)
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Wait until the page layout is fully mounted
    if (changeInfo.status === 'complete' && tab.url) {
      const url = new URL(tab.url.toLowerCase());
      
      // Check path or subdomains against career indicators
      const isMatch = CAREER_KEYWORDS.some(keyword => url.pathname.includes(keyword)) ||
                      url.hostname.includes("lever.co") || 
                      url.hostname.includes("greenhouse.io") ||
                      url.hostname.includes("workdayjobs.com") ||
                      url.hostname.includes("linkedin.com/jobs") ||
                      url.hostname.includes("wellfound.com/jobs");

      if (isMatch) {
        // Ping content.ts to run deep DOM pattern evaluation and wake up the side panel HUD
        browser.tabs.sendMessage(tabId, { action: "SCAN_ACTIVE_PORTAL" }).catch(() => {});
      }
    }
  });

  // Helper to fetch user ID
  async function getUserId(): Promise<string> {
    try {
      const data = (await browser.storage.local.get('userId')) as any;
      if (data.userId && typeof data.userId === 'string') return data.userId;
      
      // Auto-generate stable UUID if not present
      const newId = `usr-${Math.random().toString(36).substring(2, 11)}`;
      await browser.storage.local.set({ userId: newId });
      return newId;
    } catch (e) {
      return 'default-user';
    }
  }

  async function pollForNewJobs() {
    const userId = await getUserId();
    
    try {
      const storage = await browser.storage.local.get('monitorConfig') as any;
      const cfg = storage.monitorConfig;

      if (!cfg || !cfg.active) {
        console.log('[Background] Monitor is inactive. Skipping background alert polling.');
        return;
      }

      const alertsEnabled = cfg.instantAlerts ?? true;

      const response = await fetch('http://localhost:5000/api/new-jobs', {
        headers: {
          'X-User-Id': userId,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 404) return;
        throw new Error(`HTTP error ${response.status}`);
      }

      const newJobs: any[] = await response.json();
      if (!newJobs || newJobs.length === 0) return;

      console.log(`[Background] Polled backend: ${newJobs.length} new jobs detected!`);

      // Load company watchlist
      const wlStorage = await browser.storage.local.get('companyWatchlist') as any;
      const watchlist: any[] = wlStorage?.companyWatchlist ?? [];

      // Trigger native notification for each job matching user filters OR watchlist
      for (const job of newJobs) {
        const matchesFilters = jobMatchesConfig(job, cfg);
        const watchlistMatch = checkWatchlistMatch(job, watchlist);

        if (!matchesFilters && !watchlistMatch) {
          continue;
        }
        if (!alertsEnabled) {
          console.log(`[Background] Alerts disabled. Skipping alert for "${job.title}".`);
          continue;
        }

        const notificationId = `job-alert-${job.id}-${Date.now()}`;
        notificationUrls.set(notificationId, job.url);

        const isWatchlist = watchlistMatch && !matchesFilters;
        browser.notifications.create(notificationId, {
          type: 'basic',
          iconUrl: '/icon/128.png',
          title: isWatchlist
            ? `🎯 Watchlist Hit: ${job.companyName}`
            : `🚨 New Match: ${job.companyName}`,
          message: `${job.title}\n📍 ${job.location}`,
          buttons: [
            { title: 'Apply Now →' }
          ],
          priority: 2
        });
      }
    } catch (err) {
      console.warn('[Background] Connection to NextRole backend failed. Will retry. Error details:', err);
    }
  }

  // Check if a job matches any entry in the company watchlist
  function checkWatchlistMatch(job: any, watchlist: any[]): boolean {
    if (!watchlist || watchlist.length === 0) return false;
    const jobTitle = (job.title ?? '').toLowerCase();
    const jobCompany = (job.companyName ?? '').toLowerCase();

    return watchlist.some((entry: any) => {
      const wCompany = (entry.company ?? '').toLowerCase().trim();
      const wRole = (entry.role ?? '').toLowerCase().trim();

      // If both are specified, both must match
      if (wCompany && wRole) {
        return jobCompany.includes(wCompany) && jobTitle.includes(wRole);
      }
      // If only company, match any role at that company
      if (wCompany) return jobCompany.includes(wCompany);
      // If only role, match that role at any company
      if (wRole) return jobTitle.includes(wRole);
      return false;
    });
  }

  // Handle notification button clicks to redirect to application page
  browser.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
    console.log(`[Background] Notification button clicked. ID: ${notifId}, Button: ${btnIndex}`);
    const url = notificationUrls.get(notifId);
    if (url) {
      browser.tabs.create({ url });
      browser.notifications.clear(notifId);
    }
  });

  // Handle notification body click as a fallback click handler
  browser.notifications.onClicked.addListener((notifId) => {
    console.log(`[Background] Notification clicked. ID: ${notifId}`);
    const url = notificationUrls.get(notifId);
    if (url) {
      browser.tabs.create({ url });
      browser.notifications.clear(notifId);
    }
  });

  // Active monitor config (synced from popup)
  let monitorConfig: any = null;
  let alertsEnabled = true;

  // ── Keyword matching helper ────────────────────────────
  function jobMatchesConfig(job: any, cfg: any): boolean {
    if (!cfg || cfg.mode === 'all') return true;
    const haystack = `${job.title ?? ''} ${job.description ?? ''}`.toLowerCase();
    const locationStr = (job.location ?? '').toLowerCase();

    const roleMatch = cfg.roles.length === 0 || cfg.roles.some((r: string) => haystack.includes(r.toLowerCase()));
    const stackMatch = cfg.stack.length === 0 || cfg.stack.some((s: string) => haystack.includes(s.toLowerCase()));

    let locationMatch = true;
    if (cfg.location && cfg.location !== 'anywhere') {
      const locMap: Record<string, string[]> = {
        'anywhere-india': ['india', 'in'],
        'remote': ['remote', 'anywhere', 'worldwide'],
        'bangalore': ['bangalore', 'bengaluru'],
        'mumbai': ['mumbai', 'bombay'],
        'delhi': ['delhi', 'ncr', 'gurgaon', 'noida'],
        'hyderabad': ['hyderabad'],
        'pune': ['pune'],
        'us-remote': ['remote', 'us', 'united states'],
      };
      const terms = locMap[cfg.location] ?? [cfg.location];
      locationMatch = terms.some(t => locationStr.includes(t));
    }

    return roleMatch && stackMatch && locationMatch;
  }

  // Listen for message requests from content/popup scripts
  browser.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    if (message.action === 'openTab' && message.url) {
      browser.tabs.create({ url: message.url });
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'startMonitor') {
      monitorConfig = message.config;
      alertsEnabled = message.config.instantAlerts ?? true;
      console.log('[Background] Monitor started with config:', monitorConfig);
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'stopMonitor') {
      monitorConfig = null;
      console.log('[Background] Monitor stopped.');
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'setAlerts') {
      alertsEnabled = message.enabled;
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'MASTER_PROFILE_MUTATED') {
      console.log('[Background] Master profile updated. Refreshing active content scripts...');
      // Broadcast to all tabs so content scripts re-score with new profile data
      browser.tabs.query({}).then(tabs => {
        for (const tab of tabs) {
          if (tab.id) {
            browser.tabs.sendMessage(tab.id, { action: 'MASTER_PROFILE_MUTATED' }).catch(() => {});
          }
        }
      });
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'fetchBackend') {
      const { url, method, headers, body } = message;
      fetch(url, {
        method: method || 'GET',
        headers: headers || {},
        body: body ? JSON.stringify(body) : undefined
      })
      .then(async (res) => {
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = text; }
        sendResponse({ success: res.ok, status: res.status, data });
      })
      .catch((err) => {
        console.warn(`[Background] Fetch to ${url} failed:`, err);
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }

    // ── Career Feed Storage Broker ─────────────────────────
    if (message.action === 'UPDATE_CAREER_FEED') {
      const incomingJob = message.job;
      if (!incomingJob?.title || !incomingJob?.company) {
        sendResponse({ success: false, error: 'Invalid job payload' });
        return true;
      }

      (async () => {
        try {
          const stored = (await browser.storage.local.get('scrapedJobs')) as any;
          const existingJobs: any[] = stored.scrapedJobs || [];

          // Deduplicate by title + company signature
          const signature = `${incomingJob.title.toLowerCase()}::${incomingJob.company.toLowerCase()}`;
          const isDuplicate = existingJobs.some(j =>
            `${j.title?.toLowerCase()}::${j.company?.toLowerCase()}` === signature
          );

          if (!isDuplicate) {
            // Prepend newest to front, cap at 100 entries
            const updatedJobs = [incomingJob, ...existingJobs].slice(0, 100);
            await browser.storage.local.set({ scrapedJobs: updatedJobs });
            console.log(`[Background] ✅ Career Feed updated: "${incomingJob.title}" at "${incomingJob.company}"`);

            // Broadcast refresh signal to all active content scripts
            const tabs = await browser.tabs.query({ active: true });
            for (const tab of tabs) {
              if (tab.id) {
                browser.tabs.sendMessage(tab.id, { action: 'REFRESH_HUD_FEED' }).catch(() => {});
              }
            }
          } else {
            console.log(`[Background] ⏭️ Duplicate skipped: "${incomingJob.title}"`);
          }

          sendResponse({ success: true });
        } catch (err: any) {
          console.error('[Background] Career Feed storage broker error:', err);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // Keep channel open for async sendResponse
    }
  });



  // 1. Establish persistent alarm routine
  browser.runtime.onInstalled.addListener(() => {
    console.log("📡 NextRole Core Engine Activated.");
    browser.alarms.create("POLL_INSTANT_ALERTS", {
      periodInMinutes: 15 // Frequency of headless background checks
    });
  });

  // 2. Listen for the alarm trigger
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "POLL_INSTANT_ALERTS") {
      await pollForNewJobs();
    }
  });

  // Run immediately once on boot
  pollForNewJobs();
});
