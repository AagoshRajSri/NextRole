export default defineBackground(() => {
  console.log('[NextRole] Service worker initialized. Starting background polling loop...');

  // Map to store job URLs dynamically linked to notification IDs
  const notificationUrls = new Map<string, string>();

  // Poll interval (every 30 seconds for immediate responsiveness in local testing)
  const POLL_INTERVAL = 30 * 1000;
  
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

      // Trigger native notification for each job
      for (const job of newJobs) {
        const notificationId = `job-alert-${job.id}-${Date.now()}`;
        notificationUrls.set(notificationId, job.url);

        browser.notifications.create(notificationId, {
          type: 'basic',
          iconUrl: '/icon/128.png', // Uses WXT auto-packaged extension icon
          title: `🚨 New Job Alert: ${job.companyName}`,
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
  });

  // Override pollForNewJobs to respect keyword config
  const _origPoll = pollForNewJobs;
  (globalThis as any).__nrPollOverride = async function() {
    const userId = await getUserId();
    try {
      const response = await fetch('http://localhost:5000/api/new-jobs', {
        headers: { 'X-User-Id': userId, 'Accept': 'application/json' }
      });
      if (!response.ok) return;
      const newJobs: any[] = await response.json();
      if (!newJobs?.length) return;

      for (const job of newJobs) {
        if (!jobMatchesConfig(job, monitorConfig)) continue;
        if (!alertsEnabled) continue;
        const notificationId = `job-alert-${job.id}-${Date.now()}`;
        notificationUrls.set(notificationId, job.url);
        browser.notifications.create(notificationId, {
          type: 'basic',
          iconUrl: '/icon/128.png',
          title: `🚨 New Match: ${job.companyName}`,
          message: `${job.title}\n📍 ${job.location}`,
          buttons: [{ title: 'Apply Now →' }],
          priority: 2
        });
      }
    } catch (err) {
      console.warn('[Background] Poll failed:', err);
    }
  };

  // Start polling
  pollForNewJobs();
  setInterval(pollForNewJobs, POLL_INTERVAL);
});
