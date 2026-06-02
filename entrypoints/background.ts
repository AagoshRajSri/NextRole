import { browser } from 'wxt/browser';
import {
  profileStorage,
  trackedPagesStorage,
  unseenJobsStorage,
  monitorStateStorage,
  userIdStorage,
  remoteSelectorsStorage,
  dismissedJobIdsStorage,
  StoredJob,
  TrackedPage,
  extractReadableLabel,
} from '../lib/storage';
import { normalizeCareerUrl, detectPlatform, buildJobId, injectSortParam } from '../lib/utils';
import { AsyncLock } from '../lib/asyncLock';
import { ApiClient } from '../lib/apiClient';
import { logger } from '../lib/logger';
import { CONFIG } from '../lib/config';
import { io } from 'socket.io-client';
import { getCompanyTrackingUrls } from '../lib/companyDirectory';
import { calculateMatchScore, isCrossPlatformDuplicate } from '../lib/matchScoring';
import { fireNotifications, getPendingNotification, clearPendingNotification } from '../lib/notificationManager';
import { routeMessage } from '../lib/messageRouter';

export default defineBackground(() => {
  const API_BASE = CONFIG.API_BASE_URL;
  const POLL_ALARM = 'POLL_JOBS';
  const DAILY_PRUNE = 'DAILY_PRUNE';
  const storageLock = new AsyncLock();

  // ── USER ID ──
  async function getUserId(): Promise<string> {
    let id = await userIdStorage.getValue();
    if (!id) { id = crypto.randomUUID(); await userIdStorage.setValue(id); }
    return id;
  }

  // Match scoring and deduplication extracted to lib/matchScoring.ts

  // ── BADGE ──
  async function updateBadge() {
    try {
      const monitorState = await monitorStateStorage.getValue();
      const jobs = await unseenJobsStorage.getValue() || [];
      const count = jobs.filter(j => !j.seenAt && !j.dismissed).length;
      if (!monitorState?.active) {
        await browser.action.setBadgeText({ text: '—' });
        await browser.action.setBadgeBackgroundColor({ color: '#5A7A9A' });
        return;
      }
      if (count > 0) {
        await browser.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
        await browser.action.setBadgeBackgroundColor({ color: '#00E5FF' });
      } else {
        await browser.action.setBadgeText({ text: '' });
      }
    } catch {}
  }

  // Notifications extracted to lib/notificationManager.ts

  browser.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
    if (notifId.startsWith('digest-')) { browser.action.openPopup?.().catch(() => {}); return; }
    try {
      const entry = await getPendingNotification(notifId);
      if (btnIdx === 0 && entry?.jobUrl) {
        await browser.tabs.create({ url: entry.jobUrl, active: true });
        const jobId = notifId.replace('job-', '');
        const release = await storageLock.acquire();
        try {
          const jobs = await unseenJobsStorage.getValue() ?? [];
          await unseenJobsStorage.setValue(jobs.map(j => j.id === jobId ? { ...j, seenAt: Date.now() } : j));
        } finally { release(); }
      } else if (btnIdx === 1) {
        const jobId = notifId.replace('job-', '');
        const release = await storageLock.acquire();
        try {
          const jobs = await unseenJobsStorage.getValue() ?? [];
          await unseenJobsStorage.setValue(jobs.map(j => j.id === jobId ? { ...j, snoozedUntil: Date.now() + 3600000 } : j));
        } finally { release(); }
      }
      browser.notifications.clear(notifId);
      await clearPendingNotification(notifId);
    } catch (err) {
      logger.warn('notifications', 'Error handling button click', err);
    }
    await updateBadge();
  });

  browser.notifications.onClicked.addListener(async (notifId) => {
    try {
      const entry = await getPendingNotification(notifId);
      if (entry?.jobUrl) {
        await browser.tabs.create({ url: entry.jobUrl });
      } else if (notifId.startsWith('job-')) {
        const jobs = await unseenJobsStorage.getValue() ?? [];
        const job = jobs.find(j => j.id === notifId.replace('job-', ''));
        if (job?.url) await browser.tabs.create({ url: job.url });
      }
    } catch (err) {
      logger.warn('notifications', 'Error handling notification click', err);
    }
    browser.notifications.clear(notifId);
  });

  // ── SCAN RESULT HANDLER (with AsyncLock) ──
  async function handleScanResult(payload: { url: string; platform: string; jobs: any[]; scannedAt: number }, tabId?: number) {
    const profile = await profileStorage.getValue();
    if (!profile) return;

    const release = await storageLock.acquire();
    try {
      const trackedPages = await trackedPagesStorage.getValue() || [];
      const normalizedUrl = normalizeCareerUrl(payload.url);
      const trackedPage = trackedPages.find(p => p.normalizedUrl === normalizedUrl);

      const unseenJobs = await unseenJobsStorage.getValue() || [];
      const dismissedIds = await dismissedJobIdsStorage.getValue() || [];
      const seenIds = new Set([...unseenJobs.map(j => j.id), ...dismissedIds]);

      const newJobs = payload.jobs.filter(j => !seenIds.has(buildJobId(j, payload.url)));
      if (newJobs.length === 0) {
        if (trackedPage) await updateTrackedPageStatus(trackedPage.id, payload.scannedAt, 'ok', 0);
        return;
      }

      const fallbackCompany = extractReadableLabel(normalizedUrl).title;
      const matched = newJobs
        .map(job => {
          const evalJob = { ...job, companyName: job.companyName || fallbackCompany };
          return { job, ...calculateMatchScore(evalJob, profile) };
        })
        .filter(m => m.score > 0);

      // Cross-platform dedup
      const deduped = matched.filter(m => {
        const stub: StoredJob = { id: buildJobId(m.job, payload.url), title: m.job.title, companyName: m.job.companyName || '', location: m.job.location || '', url: m.job.url, sourcePageUrl: payload.url, sourceDomain: '', matchReason: '', firstSeenAt: 0, seenAt: null, snoozedUntil: null, dismissed: false, appliedAt: null, applicationStatus: null };
        return !isCrossPlatformDuplicate(stub, unseenJobs);
      });

      if (deduped.length === 0) {
        if (trackedPage) await updateTrackedPageStatus(trackedPage.id, payload.scannedAt, 'ok', 0);
        return;
      }

      const storedJobs: StoredJob[] = deduped.map(({ job, score, reason, breakdown }) => ({
        id: buildJobId(job, payload.url),
        title: job.title,
        companyName: job.companyName || extractReadableLabel(normalizedUrl).title,
        location: job.location || '',
        url: job.url,
        sourcePageUrl: payload.url,
        sourceDomain: new URL(payload.url).hostname.replace('www.', ''),
        matchReason: reason,
        matchScore: score,
        matchBreakdown: breakdown,
        firstSeenAt: Date.now(),
        seenAt: null, snoozedUntil: null, dismissed: false, appliedAt: null, applicationStatus: null,
      }));

      const updatedJobs = [...storedJobs, ...unseenJobs].slice(0, 500);
      await unseenJobsStorage.setValue(updatedJobs);

      if (trackedPage) await updateTrackedPageStatus(trackedPage.id, payload.scannedAt, 'ok', deduped.length);

      const ms = await monitorStateStorage.getValue();
      if (ms) {
        await monitorStateStorage.setValue({ ...ms, lastPollAt: Date.now(), lastCycleMatchCount: deduped.length, totalJobsFound: (ms.totalJobsFound || 0) + deduped.length });
      }

      await updateBadge();
      await fireNotifications(storedJobs, profile);

      if (tabId) {
        browser.tabs.sendMessage(tabId, { type: 'NEW_JOBS_FOR_PAGE', payload: { url: payload.url, jobs: storedJobs } }).catch(err => logger.warn('scan', 'Failed to send jobs to tab', err));
      }

      syncJobsToBackend(storedJobs, normalizedUrl).catch(err => logger.warn('scan', 'syncJobsToBackend failed', err));
    } finally {
      release();
    }
  }

  async function updateTrackedPageStatus(id: string, scannedAt: number, status: string, newCount: number) {
    const pages = await trackedPagesStorage.getValue() || [];
    const idx = pages.findIndex(p => p.id === id);
    if (idx >= 0) {
      pages[idx] = { ...pages[idx], lastScrapedAt: scannedAt, lastScrapeStatus: status as any, newJobCount: (pages[idx].newJobCount || 0) + newCount };
      await trackedPagesStorage.setValue(pages);
    }
  }

  // ── BACKEND SYNC (fire-and-forget) ──
  async function syncJobsToBackend(jobs: StoredJob[], pageUrl: string) {
    const profile = await profileStorage.getValue();
    if (!profile) return;
    const userId = await getUserId();
    const apiClient = new ApiClient(userId);
    try {
      const p1 = apiClient.post('/api/tracked-searches', { url: pageUrl, platform: 'client' });
      const p2 = apiClient.post('/api/jobs/bulk', { pageUrl, jobs: jobs.map(j => ({ atsJobId: j.id.split('::')[1], title: j.title, location: j.location, url: j.url, companyName: j.companyName, matchReason: j.matchReason })) });
      const [r1, r2] = await Promise.all([p1, p2]);
      if (r1.offline || r2.offline) logger.info('sync', 'Backend offline, will retry on next cycle');
      else if (r1.error || r2.error) logger.error('sync', 'Failed to sync to backend', { r1, r2 });
    } catch (e) {
      logger.error('sync', 'Sync error', e);
    }
  }

  // ── AUTO-TRACK COMPANY PAGES ──
  async function autoTrackCompanyPages(companyNames: string[]) {
    const pages = await trackedPagesStorage.getValue() || [];
    const userId = await getUserId();
    const apiClient = new ApiClient(userId);
    let added = 0;

    for (const company of companyNames) {
      const { urls, displayName } = getCompanyTrackingUrls(company);
      for (const url of urls) {
        const normalized = normalizeCareerUrl(url);
        if (!pages.find(p => p.normalizedUrl === normalized)) {
          const newPage: TrackedPage = {
            id: crypto.randomUUID(),
            url,
            normalizedUrl: normalized,
            label: displayName,
            subtitle: 'Auto-tracked from Watchlist',
            addedAt: Date.now(),
            lastScrapedAt: null,
            lastScrapeStatus: 'pending',
            lastScrapeError: null,
            newJobCount: 0,
            isPending: false,
            platform: detectPlatform(url),
          };
          pages.push(newPage);
          added++;
          
          // Send to backend so it starts scraping immediately
          apiClient.post('/api/tracked-searches', { url, platform: newPage.platform }).catch(() => {});
        }
      }
    }
    
    if (added > 0) {
      await trackedPagesStorage.setValue(pages);
      logger.info('auto-track', `Auto-tracked ${added} pages for ${companyNames.length} companies`);
    }
  }

  // ── DYNAMIC CONTENT SCRIPT INJECTION ──
  function isCareerPageUrl(url: string): boolean {
    const patterns = ['/careers', '/jobs', '/job-openings', '/open-roles', '/openings', '/positions', '/hiring', '/work-with-us', '/join-us', '/vacancies', '/opportunities'];
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host.startsWith('careers.') || host.startsWith('jobs.')) return true;
      return patterns.some(p => u.pathname.toLowerCase().includes(p));
    } catch { return false; }
  }

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab.url) return;
    const staticDomains = ['linkedin.com', 'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'ashbyhq.com', 'workable.com'];
    if (staticDomains.some(d => tab.url!.includes(d))) return;
    if (isCareerPageUrl(tab.url)) {
      try { await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] }); } catch {}
    }
  });

  // ── STORAGE PRUNING ──
  async function pruneOldJobs() {
    const release = await storageLock.acquire();
    try {
      const jobs = await unseenJobsStorage.getValue() || [];
      const thirtyDaysAgo = Date.now() - 30 * 86400000;
      const pruned = jobs.filter(j => {
        if (!j.seenAt) return true;
        if (j.appliedAt) return true;
        return j.seenAt > thirtyDaysAgo;
      }).slice(0, 500);
      if (pruned.length < jobs.length) {
        await unseenJobsStorage.setValue(pruned);
        logger.info('prune', `Pruned ${jobs.length - pruned.length} old jobs`);
      }
    } finally { release(); }
  }

  // ── TAB HELPERS ──
  async function getOpenTrackedTabs(): Promise<Array<{ tab: any; trackedPage: TrackedPage }>> {
    const [allTabs, trackedPages] = await Promise.all([browser.tabs.query({}), trackedPagesStorage.getValue()]);
    const results: Array<{ tab: any; trackedPage: TrackedPage }> = [];
    for (const tab of allTabs) {
      if (!tab.url || !tab.id) continue;
      const tp = (trackedPages || []).find(p => p.normalizedUrl === normalizeCareerUrl(tab.url!));
      if (tp) results.push({ tab, trackedPage: tp });
    }
    return results;
  }

  // ── MESSAGING ──
  browser.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    const deps = {
      storageLock,
      getUserId,
      handleScanResult,
      updateBadge,
      autoTrackCompanyPages,
      syncRemoteSelectors,
      connectSocket,
      getOpenTrackedTabs,
      getSocketStatus: () => socket ? socket.connected : false,
      POLL_ALARM
    };
    routeMessage(message, sender, deps)
      .then(res => { if (res !== undefined) sendResponse(res); })
      .catch(err => logger.warn('msg', 'Message routing failed', err));
    return true;
  });

  // ── ALARMS ──
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name.startsWith('notif-keepalive-')) { browser.alarms.clear(alarm.name); return; }
    if (alarm.name === DAILY_PRUNE) { await pruneOldJobs(); return; }
    if (alarm.name !== POLL_ALARM) return;

    const ms = await monitorStateStorage.getValue();
    if (!ms?.active) return;

    // 1. Trigger DOM scans in any open career tabs
    const openTabs = await getOpenTrackedTabs();
    for (const { tab } of openTabs) {
      if (tab.id) browser.tabs.sendMessage(tab.id, { type: 'TRIGGER_SCAN' }).catch(err => logger.warn('poll', 'Failed to trigger scan on tab', err));
    }

    // 2. Poll backend for new jobs — fires notifications even with ZERO tabs open
    await pollBackendForNewJobs();

    await monitorStateStorage.setValue({ ...ms, lastPollAt: Date.now() });
  });

  // ── BACKGROUND BACKEND POLL ──
  async function pollBackendForNewJobs() {
    try {
      const profile = await profileStorage.getValue();
      if (!profile?.isOnboarded) return;

      const userId = await getUserId();
      const apiClient = new ApiClient(userId);

      // Use last poll time so we only fetch truly new jobs
      const ms = await monitorStateStorage.getValue();
      const since = ms?.lastPollAt ?? (Date.now() - 20 * 60 * 1000);

      const { data, error, offline } = await apiClient.get<any[]>(`/api/jobs/new?since=${since}`);
      if (offline || error || !data || data.length === 0) return;

      logger.info('poll', `Backend poll found ${data.length} new job(s)`);

      // Merge into local storage, deduplicating by id OR url
      const existingJobs = await unseenJobsStorage.getValue() || [];
      const existingIds = new Set(existingJobs.map(j => j.id));
      const existingUrls = new Set(existingJobs.map(j => j.url).filter(Boolean));

      const brandNew: StoredJob[] = data
        .filter(j => !existingIds.has(j.id) && !existingUrls.has(j.url))
        .map(j => ({
          id: j.id,
          title: j.title,
          companyName: j.companyName || '',
          location: j.location || '',
          url: j.url,
          sourcePageUrl: j.url,
          sourceDomain: j.sourceDomain || '',
          matchReason: j.matchReason || 'Backend match',
          matchScore: 80, // backend already matched against profile
          firstSeenAt: j.firstSeenAt || Date.now(),
          seenAt: null,
          snoozedUntil: null,
          dismissed: false,
          appliedAt: null,
          applicationStatus: null,
        }));

      if (brandNew.length === 0) return;

      await unseenJobsStorage.setValue([...brandNew, ...existingJobs].slice(0, 500));
      await updateBadge();
      await fireNotifications(brandNew, profile);
    } catch (err) {
      logger.warn('poll', 'Backend poll failed', err);
    }
  }

  // ── RETROACTIVE UPGRADE ──
  async function upgradeSortParams() {
    const pages = await trackedPagesStorage.getValue() || []
    let changed = false
    
    const upgraded = pages.map(page => {
      const platform = detectPlatform(page.url)
      const sortedUrl = injectSortParam(page.url, platform)
      
      if (sortedUrl === page.url) return page
      
      changed = true
      return {
        ...page,
        displayUrl: page.displayUrl || page.url,
        url: sortedUrl,
        normalizedUrl: normalizeCareerUrl(sortedUrl),
      }
    })
    
    if (changed) {
      await trackedPagesStorage.setValue(upgraded)
      console.log('[NextRole] Upgraded sort params on tracked pages')
    }
  }

  // ── WEBSOCKET REALTIME ALERTS ──
  let socket: any = null;
  async function connectSocket() {
    const userId = await getUserId();
    if (socket) socket.disconnect();
    
    socket = io(API_BASE, {
      auth: { userId },
      transports: ['websocket', 'polling']
    });

    socket.on('connect', () => {
      logger.info('socket', 'Connected to real-time alerts server');
      browser.runtime.sendMessage({ type: 'SOCKET_STATUS', connected: true }).catch(err => logger.warn('socket', 'Failed to broadcast connect', err));
    });

    socket.on('disconnect', () => {
      logger.warn('socket', 'Disconnected from real-time alerts server');
      browser.runtime.sendMessage({ type: 'SOCKET_STATUS', connected: false }).catch(err => logger.warn('socket', 'Failed to broadcast disconnect', err));
    });

    socket.on('JOB_ALERT_DISCOVERED', async (job: any) => {
      logger.info('socket', 'New job alert received via socket', job);
      const profile = await profileStorage.getValue();
      if (!profile) return;

      const sourceDomain = (() => { try { return new URL(job.url).hostname.replace('www.', ''); } catch { return ''; } })();

      const newJob: StoredJob = {
        id: job.id,
        title: job.title,
        companyName: job.companyName,
        location: job.location,
        url: job.url,
        sourcePageUrl: job.url,
        sourceDomain,
        matchReason: job.matchReason,
        matchScore: 100,
        firstSeenAt: Date.now(),
        seenAt: null,
        snoozedUntil: null,
        dismissed: false,
        appliedAt: null,
        applicationStatus: null,
      };

      const jobs = await unseenJobsStorage.getValue() || [];
      // Dedup by URL (not just by id) — handles client-scanned jobs with different ID format
      const isDuplicate = jobs.some(j => j.id === job.id || j.url === job.url);
      if (!isDuplicate) {
        await unseenJobsStorage.setValue([newJob, ...jobs].slice(0, 500));
        await updateBadge();
        await fireNotifications([newJob], profile);
      }
    });
  }

  // ── STARTUP ──
  const syncRemoteSelectors = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/selectors`);
      if (res.ok) {
        const selectors = await res.json();
        await remoteSelectorsStorage.setValue(selectors);
        logger.info('selectors', 'Synced remote selectors successfully');
      }
    } catch (err) {
      logger.warn('selectors', 'Failed to sync remote selectors', err);
    }
  };

  const syncSessionCookies = async () => {
    try {
      const domains = ['.linkedin.com', 'linkedin.com', '.myworkdayjobs.com', '.greenhouse.io', '.lever.co'];
      const cookies = [];
      
      for (const domain of domains) {
        const domainCookies = await browser.cookies.getAll({ domain });
        cookies.push(...domainCookies);
      }
      
      if (cookies.length > 0) {
        // SECURITY TODO: Cookies are currently encrypted at rest in the backend (AES-256-GCM),
        // but passing session cookies over the wire requires strict HTTPS and high trust.
        // For enhanced security, implement E2E encryption (e.g. encrypt with user's public key here).
        const userId = await getUserId();
        const apiClient = new ApiClient(userId);
        await apiClient.post('/api/cookies', { cookies });
        logger.info('cookies', `Synced ${cookies.length} session cookies`);
      }
    } catch (err) {
      logger.warn('cookies', 'Failed to sync session cookies', err);
    }
  };

  const setupAlarms = async () => {
    const ms = await monitorStateStorage.getValue();
    if (ms?.active) browser.alarms.create(POLL_ALARM, { periodInMinutes: 15 });
    browser.alarms.create(DAILY_PRUNE, { periodInMinutes: 1440 });
    await updateBadge();
    upgradeSortParams().catch(err => logger.warn('startup', 'upgradeSortParams failed', err));
    syncRemoteSelectors().catch(err => logger.warn('startup', 'syncRemoteSelectors failed', err));
    syncSessionCookies().catch(err => logger.warn('startup', 'syncSessionCookies failed', err));
    connectSocket().catch(err => logger.warn('startup', 'connectSocket failed', err));
  };
  browser.runtime.onStartup.addListener(setupAlarms);
  browser.runtime.onInstalled.addListener(setupAlarms);
});
