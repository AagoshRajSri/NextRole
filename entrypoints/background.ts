import { browser } from 'wxt/browser';
import {
  profileStorage,
  trackedPagesStorage,
  unseenJobsStorage,
  monitorStateStorage,
  dismissedJobIdsStorage,
  userIdStorage,
  StoredJob,
  TrackedPage,
  MonitorState,
  extractReadableLabel,
  normalizeCareerUrl,
  isCareerPage,
} from '../lib/storage';

export default defineBackground(() => {
  const API_BASE = 'http://localhost:5000';
  const POLL_ALARM = 'POLL_JOBS';
  const DIGEST_ALARM = 'DAILY_DIGEST';
  const MAX_NOTIFS_PER_CYCLE = 4;

  // ────────────────────────────────────────────────────────
  // USER ID
  // ────────────────────────────────────────────────────────
  async function getUserId(): Promise<string> {
    let id = await userIdStorage.getValue();
    if (!id) {
      id = crypto.randomUUID();
      await userIdStorage.setValue(id);
    }
    return id;
  }

  async function fetchApi(path: string, options?: RequestInit): Promise<Response> {
    const userId = await getUserId();
    return fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
        ...(options?.headers || {}),
      },
    });
  }

  // ────────────────────────────────────────────────────────
  // KEYWORD MATCHING
  // ────────────────────────────────────────────────────────
  function jobMatchesProfile(
    job: { title: string; companyName?: string },
    profile: { targetRoles: string[]; watchlistCompanies: string[]; experienceLevel?: string },
  ): { matched: boolean; reason: string } {
    const title = (job.title ?? '').toLowerCase();
    const company = (job.companyName ?? '').toLowerCase();

    const seniorTerms = ['senior', 'staff', 'principal', 'lead', 'director', 'vp', 'head of'];
    const isSeniorRole = seniorTerms.some(s => title.includes(s));
    const isJuniorProfile = ['fresher', '1-3'].includes(profile.experienceLevel ?? '');

    for (const role of profile.targetRoles) {
      if (role.trim() && title.includes(role.trim().toLowerCase())) {
        if (isJuniorProfile && isSeniorRole) continue;
        return { matched: true, reason: `role:${role}` };
      }
    }

    for (const co of profile.watchlistCompanies) {
      const coLower = co.trim().toLowerCase();
      if (!coLower) continue;
      if (company.includes(coLower) || coLower.includes(company)) {
        if (isJuniorProfile && isSeniorRole) continue;
        return { matched: true, reason: `company:${co}` };
      }
    }

    return { matched: false, reason: '' };
  }

  // ────────────────────────────────────────────────────────
  // BADGE
  // ────────────────────────────────────────────────────────
  async function updateBadge() {
    try {
      const jobs = await unseenJobsStorage.getValue();
      const count = (jobs ?? []).filter(j => !j.seenAt && !j.dismissed).length;
      await browser.action.setBadgeText({ text: count > 0 ? String(count) : '' });
      await browser.action.setBadgeBackgroundColor({ color: '#00E5FF' });
    } catch { /* non-fatal */ }
  }

  // ────────────────────────────────────────────────────────
  // NOTIFICATIONS
  // ────────────────────────────────────────────────────────
  function fireJobNotification(job: StoredJob) {
    browser.notifications.create(`job-${job.id}`, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: job.title.slice(0, 50),
      message: `${job.companyName} · ${job.location}`,
      contextMessage: `Match: ${job.matchReason}`,
      requireInteraction: false,
      buttons: [{ title: 'Open job →' }, { title: 'Snooze 1h' }],
    });
  }

  function fireSummaryNotification(count: number) {
    browser.notifications.create('digest-summary', {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: `${count} more new match${count !== 1 ? 'es' : ''}`,
      message: 'Open NextRole to view all jobs',
      requireInteraction: false,
    });
  }

  browser.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
    const jobId = notifId.replace('job-', '');
    const jobs = await unseenJobsStorage.getValue() ?? [];
    const job = jobs.find(j => j.id === jobId);

    if (btnIdx === 0 && job?.url) {
      browser.tabs.create({ url: job.url });
      // Mark as seen
      const updated = jobs.map(j => j.id === jobId ? { ...j, seenAt: Date.now() } : j);
      await unseenJobsStorage.setValue(updated);
      await updateBadge();
    } else if (btnIdx === 1) {
      // Snooze 1h
      const snoozedUntil = Date.now() + 3600000;
      const updated = jobs.map(j => j.id === jobId ? { ...j, snoozedUntil } : j);
      await unseenJobsStorage.setValue(updated);
    }
    browser.notifications.clear(notifId);
  });

  browser.notifications.onClicked.addListener(async (notifId) => {
    if (notifId === 'digest-summary') {
      browser.action.openPopup?.().catch(() => {});
      browser.notifications.clear(notifId);
      return;
    }
    const jobId = notifId.replace('job-', '');
    const jobs = await unseenJobsStorage.getValue() ?? [];
    const job = jobs.find(j => j.id === jobId);
    if (job?.url) browser.tabs.create({ url: job.url });
    browser.notifications.clear(notifId);
  });

  // ────────────────────────────────────────────────────────
  // POLLING CORE
  // ────────────────────────────────────────────────────────
  async function pollNewJobs() {
    const profile = await profileStorage.getValue();
    const monitorState = await monitorStateStorage.getValue();

    if (!profile?.isOnboarded || !monitorState.active) {
      console.log('[BG] Monitor paused or not onboarded, skipping poll.');
      return;
    }

    console.log('[BG] Polling /api/new-jobs...');

    try {
      const res = await fetchApi('/api/new-jobs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const newJobs: any[] = await res.json();

      if (newJobs.length === 0) {
        await monitorStateStorage.setValue({
          ...monitorState,
          lastPollAt: Date.now(),
          lastCycleMatchCount: 0,
        });
        return;
      }

      // Load dismissed IDs for filtering
      const dismissedIds = new Set(await dismissedJobIdsStorage.getValue() ?? []);

      // Filter + match
      const matched: StoredJob[] = [];
      for (const job of newJobs) {
        if (dismissedIds.has(job.id)) continue;

        const result = jobMatchesProfile(job, profile);
        if (!result.matched) continue;

        let sourceDomain = '';
        try { sourceDomain = new URL(job.url).hostname.replace('www.', ''); } catch {}

        matched.push({
          id: job.id,
          title: job.title,
          companyName: job.companyName || 'Unknown',
          location: job.location || 'Remote',
          url: job.url,
          sourcePageUrl: job.sourcePageUrl || '',
          sourceDomain,
          matchReason: result.reason,
          firstSeenAt: job.firstSeenAt ? new Date(job.firstSeenAt).getTime() : Date.now(),
          seenAt: null,
          snoozedUntil: null,
          dismissed: false,
          appliedAt: null,
          applicationStatus: null,
        });
      }

      // Merge into storage (dedup by ID)
      const existing = await unseenJobsStorage.getValue() ?? [];
      const existingIds = new Set(existing.map(j => j.id));
      const brandNew = matched.filter(j => !existingIds.has(j.id));

      if (brandNew.length === 0) {
        await monitorStateStorage.setValue({
          ...monitorState,
          lastPollAt: Date.now(),
          lastCycleMatchCount: 0,
        });
        return;
      }

      // Write merged feed (newest first, cap at 200)
      const updatedFeed = [...brandNew, ...existing].slice(0, 200);
      await unseenJobsStorage.setValue(updatedFeed);

      // Update per-page newJobCount in trackedPages
      const pages = await trackedPagesStorage.getValue() ?? [];
      const updatedPages: TrackedPage[] = pages.map(page => {
        const pageJobs = brandNew.filter(j =>
          j.sourcePageUrl && normalizeCareerUrl(j.sourcePageUrl) === page.normalizedUrl
        );
        return pageJobs.length > 0
          ? { ...page, newJobCount: page.newJobCount + pageJobs.length }
          : page;
      });
      await trackedPagesStorage.setValue(updatedPages);

      // Update monitor state
      await monitorStateStorage.setValue({
        ...monitorState,
        lastPollAt: Date.now(),
        lastCycleMatchCount: brandNew.length,
        totalJobsFound: monitorState.totalJobsFound + brandNew.length,
      });

      await updateBadge();

      // Fire notifications
      const alertMode = profile.alertMode || 'instant';
      if (alertMode === 'instant') {
        const toNotify = brandNew.slice(0, MAX_NOTIFS_PER_CYCLE);
        toNotify.forEach(job => fireJobNotification(job));
        if (brandNew.length > MAX_NOTIFS_PER_CYCLE) {
          fireSummaryNotification(brandNew.length - MAX_NOTIFS_PER_CYCLE);
        }
      }

      // Notify open content scripts
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (tab.id && tab.url && isCareerPage(tab.url)) {
          const pageJobs = brandNew.filter(j =>
            tab.url && j.sourcePageUrl && j.sourcePageUrl.includes(new URL(tab.url).hostname)
          );
          if (pageJobs.length > 0) {
            browser.tabs.sendMessage(tab.id, {
              type: 'NEW_JOBS_FOR_PAGE',
              url: tab.url,
              jobs: pageJobs,
            }).catch(() => {});
          }
        }
      }

      console.log(`[BG] Matched ${brandNew.length} new jobs.`);
    } catch (err) {
      console.error('[BG] Poll error:', err);
    }
  }

  // ────────────────────────────────────────────────────────
  // DIGEST
  // ────────────────────────────────────────────────────────
  async function sendDigest() {
    const jobs = await unseenJobsStorage.getValue() ?? [];
    const unseen = jobs.filter(j => !j.seenAt && !j.dismissed);
    if (unseen.length === 0) return;
    fireSummaryNotification(unseen.length);

    const monitorState = await monitorStateStorage.getValue();
    await monitorStateStorage.setValue({
      ...monitorState,
      totalAlertsCount: monitorState.totalAlertsCount + 1,
    });
  }

  function nextNineAM(): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(9, 0, 0, 0);
    if (now >= target) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  // ────────────────────────────────────────────────────────
  // SNOOZE CHECK — re-surface expired snoozed jobs
  // ────────────────────────────────────────────────────────
  async function checkSnoozedJobs() {
    const jobs = await unseenJobsStorage.getValue() ?? [];
    const now = Date.now();
    let changed = false;
    const updated = jobs.map(j => {
      if (j.snoozedUntil && j.snoozedUntil <= now) {
        changed = true;
        return { ...j, snoozedUntil: null, seenAt: null };
      }
      return j;
    });
    if (changed) {
      await unseenJobsStorage.setValue(updated);
      await updateBadge();
    }
  }

  // ────────────────────────────────────────────────────────
  // ALARM HANDLER
  // ────────────────────────────────────────────────────────
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === POLL_ALARM) {
      await checkSnoozedJobs();
      await pollNewJobs();
    } else if (alarm.name === DIGEST_ALARM) {
      await sendDigest();
    }
  });

  // ────────────────────────────────────────────────────────
  // INSTALL / STARTUP
  // ────────────────────────────────────────────────────────
  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') {
      await getUserId();
      browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    }

    browser.alarms.clearAll().then(() => {
      browser.alarms.create(POLL_ALARM, { periodInMinutes: 15 });
    });
  });

  browser.runtime.onStartup.addListener(async () => {
    const monitorState = await monitorStateStorage.getValue();
    if (monitorState.active) {
      browser.alarms.create(POLL_ALARM, { periodInMinutes: 15 });
    }
    await updateBadge();
  });

  // ────────────────────────────────────────────────────────
  // TAB DETECTION
  // ────────────────────────────────────────────────────────
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab.url) return;
    if (!isCareerPage(tab.url)) return;

    const pages = await trackedPagesStorage.getValue() ?? [];
    const normalizedCurrent = normalizeCareerUrl(tab.url);
    const isTracked = pages.some(p => p.normalizedUrl === normalizedCurrent);

    browser.tabs.sendMessage(tabId, {
      type: 'SCAN_ACTIVE_PORTAL',
      url: tab.url,
      isTracked,
    }).catch(() => {});
  });

  // ────────────────────────────────────────────────────────
  // MESSAGE HANDLER
  // ────────────────────────────────────────────────────────
  browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    const type = message?.type;

    // ── Monitor controls ──
    if (type === 'START_MONITOR') {
      (async () => {
        const state = await monitorStateStorage.getValue();
        await monitorStateStorage.setValue({ ...state, active: true });
        const profile = await profileStorage.getValue();
        if (profile) await profileStorage.setValue({ ...profile, ...message.profile });
        browser.alarms.create(POLL_ALARM, { periodInMinutes: 15 });
        const p = await profileStorage.getValue();
        if (p?.alertMode === 'daily') {
          browser.alarms.create(DIGEST_ALARM, { when: nextNineAM(), periodInMinutes: 1440 });
        }
        await pollNewJobs();
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (type === 'STOP_MONITOR') {
      (async () => {
        const state = await monitorStateStorage.getValue();
        await monitorStateStorage.setValue({ ...state, active: false });
        browser.alarms.clear(POLL_ALARM);
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (type === 'TOGGLE_MONITOR') {
      (async () => {
        const state = await monitorStateStorage.getValue();
        const newActive = !state.active;
        await monitorStateStorage.setValue({ ...state, active: newActive });
        if (newActive) {
          browser.alarms.create(POLL_ALARM, { periodInMinutes: 15 });
          await pollNewJobs();
        } else {
          browser.alarms.clear(POLL_ALARM);
        }
        await updateBadge();
        sendResponse({ ok: true, active: newActive });
      })();
      return true;
    }

    // ── Profile sync ──
    if (type === 'PREFS_UPDATED') {
      (async () => {
        const current = await profileStorage.getValue();
        const updated = { ...current, ...message.changes, updatedAt: Date.now() } as any;
        await profileStorage.setValue(updated);
        const userId = await getUserId();
        fetch(`${API_BASE}/api/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
          body: JSON.stringify(updated),
        }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;
    }

    // ── Tracked searches ──
    if (type === 'ADD_TRACKED_SEARCH') {
      (async () => {
        const url = message.url as string;
        const { title, subtitle } = extractReadableLabel(url);
        const normalizedUrl = normalizeCareerUrl(url);
        const tempId = crypto.randomUUID();

        // Optimistic add
        const pages = await trackedPagesStorage.getValue() ?? [];
        if (pages.some(p => p.normalizedUrl === normalizedUrl)) {
          sendResponse({ ok: true, alreadyTracked: true });
          return;
        }

        const optimisticPage: TrackedPage = {
          id: tempId,
          url,
          normalizedUrl,
          label: title,
          subtitle,
          addedAt: Date.now(),
          lastScrapedAt: null,
          lastScrapeStatus: 'pending',
          lastScrapeError: null,
          newJobCount: 0,
          isPending: true,
        };
        await trackedPagesStorage.setValue([...pages, optimisticPage]);

        try {
          const userId = await getUserId();
          const res = await fetch(`${API_BASE}/api/tracked-searches`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
            body: JSON.stringify({ url }),
          });
          const data = await res.json();

          // Replace temp entry with real one from API
          const currentPages = await trackedPagesStorage.getValue() ?? [];
          const finalPages = currentPages.map(p =>
            p.id === tempId ? { ...p, id: data.id || tempId, isPending: false } : p
          );
          await trackedPagesStorage.setValue(finalPages);
          sendResponse({ ok: true, data });
        } catch (err: any) {
          // Rollback on failure
          const currentPages = await trackedPagesStorage.getValue() ?? [];
          await trackedPagesStorage.setValue(currentPages.filter(p => p.id !== tempId));
          sendResponse({ error: err.message });
        }
      })();
      return true;
    }

    if (type === 'DELETE_TRACKED_SEARCH') {
      (async () => {
        // Optimistic remove from storage
        const pages = await trackedPagesStorage.getValue() ?? [];
        await trackedPagesStorage.setValue(pages.filter(p => p.id !== message.id));

        // Also remove from backend
        const userId = await getUserId();
        fetch(`${API_BASE}/api/tracked-searches/${message.id}`, {
          method: 'DELETE',
          headers: { 'X-User-Id': userId },
        }).catch(() => {});

        sendResponse({ ok: true });
      })();
      return true;
    }

    if (type === 'GET_TRACKED_PAGES') {
      (async () => {
        const pages = await trackedPagesStorage.getValue() ?? [];
        sendResponse({ pages });
      })();
      return true;
    }

    // ── Feed ──
    if (type === 'GET_FEED') {
      (async () => {
        const jobs = await unseenJobsStorage.getValue() ?? [];
        sendResponse({ jobs });
      })();
      return true;
    }

    if (type === 'MARK_JOB_SEEN') {
      (async () => {
        const jobs = await unseenJobsStorage.getValue() ?? [];
        const updated = jobs.map(j => j.id === message.jobId ? { ...j, seenAt: Date.now() } : j);
        await unseenJobsStorage.setValue(updated);
        await updateBadge();
        fetchApi(`/api/jobs/${message.jobId}/seen`, { method: 'PATCH' }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (type === 'MARK_ALL_SEEN') {
      (async () => {
        const jobs = await unseenJobsStorage.getValue() ?? [];
        const now = Date.now();
        await unseenJobsStorage.setValue(jobs.map(j => ({ ...j, seenAt: j.seenAt ?? now })));
        await updateBadge();
        fetchApi('/api/jobs/seen-all', { method: 'POST' }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (type === 'SNOOZE_JOB') {
      (async () => {
        const jobs = await unseenJobsStorage.getValue() ?? [];
        const snoozedUntil = message.duration === 'tomorrow'
          ? (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); })()
          : Date.now() + (message.duration === '1h' ? 3600000 : 0);
        const updated = jobs.map(j =>
          j.id === message.jobId ? { ...j, snoozedUntil } : j
        );
        await unseenJobsStorage.setValue(updated);
        await updateBadge();
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (type === 'DISMISS_JOB') {
      (async () => {
        const jobs = await unseenJobsStorage.getValue() ?? [];
        const updated = jobs.map(j => j.id === message.jobId ? { ...j, dismissed: true } : j);
        await unseenJobsStorage.setValue(updated);

        const dismissed = await dismissedJobIdsStorage.getValue() ?? [];
        await dismissedJobIdsStorage.setValue([...dismissed, message.jobId]);
        await updateBadge();
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (type === 'CLEAR_BADGE') {
      (async () => {
        const jobs = await unseenJobsStorage.getValue() ?? [];
        const now = Date.now();
        await unseenJobsStorage.setValue(jobs.map(j => ({ ...j, seenAt: j.seenAt ?? now })));
        await updateBadge();
        sendResponse({ ok: true });
      })();
      return true;
    }

    // ── Tab status ──
    if (type === 'GET_CURRENT_TAB_STATUS') {
      (async () => {
        const pages = await trackedPagesStorage.getValue() ?? [];
        const normalizedCurrent = normalizeCareerUrl(message.url);
        const page = pages.find(p => p.normalizedUrl === normalizedCurrent);
        const isTracked = !!page;

        const jobs = await unseenJobsStorage.getValue() ?? [];
        const newCount = jobs.filter(j => !j.seenAt && !j.dismissed &&
          j.sourceDomain === message.domain
        ).length;

        sendResponse({ isTracked, newCount, page });
      })();
      return true;
    }

    // ── CSP bypass for content scripts ──
    if (type === 'fetchBackend') {
      (async () => {
        try {
          const r = await fetch(`${API_BASE}${message.path}`, {
            method: message.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...(message.headers || {}) },
            body: message.body ? JSON.stringify(message.body) : undefined,
          });
          const data = await r.json();
          sendResponse({ data });
        } catch (err: any) {
          sendResponse({ error: err.message });
        }
      })();
      return true;
    }

    // ── Health ping ──
    if (type === 'PING') {
      const start = Date.now();
      fetch(`${API_BASE}/api/health`)
        .then(() => sendResponse({ latency: Date.now() - start, online: true }))
        .catch(() => sendResponse({ latency: -1, online: false }));
      return true;
    }
  });
});
