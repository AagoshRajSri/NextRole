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

  // Listen for message requests from content/popup scripts
  browser.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    if (message.action === 'openTab' && message.url) {
      browser.tabs.create({ url: message.url });
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
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        sendResponse({ success: res.ok, status: res.status, data });
      })
      .catch((err) => {
        console.warn(`[Background] Fetch to ${url} failed:`, err);
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep message channel open for asynchronous sendResponse
    }
  });

  // Start polling
  pollForNewJobs();
  setInterval(pollForNewJobs, POLL_INTERVAL);
});
