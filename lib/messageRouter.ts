// ────────────────────────────────────────────────────────
// MESSAGE ROUTER
// Maps incoming extension messages to handler functions.
// Extracted from background.ts for clarity and testability.
// ────────────────────────────────────────────────────────

import { browser } from 'wxt/browser';
import {
  profileStorage,
  trackedPagesStorage,
  unseenJobsStorage,
  dismissedJobIdsStorage,
  extractReadableLabel,
} from './storage';
import { normalizeCareerUrl, detectPlatform } from './utils';
import { ApiClient } from './apiClient';
import { logger } from './logger';
import type { AsyncLock } from './asyncLock';

export interface RouterDeps {
  storageLock: AsyncLock;
  getUserId: () => Promise<string>;
  handleScanResult: (payload: any, tabId?: number) => Promise<void>;
  updateBadge: () => Promise<void>;
  autoTrackCompanyPages: (companies: string[]) => Promise<void>;
  syncRemoteSelectors: () => Promise<void>;
  connectSocket: () => Promise<void>;
  getOpenTrackedTabs: () => Promise<Array<{ tab: any; trackedPage: any }>>;
  getSocketStatus: () => boolean;
  POLL_ALARM: string;
}

/**
 * Handle an incoming runtime message. Returns `undefined` for unknown types
 * so the default handler can fall through.
 */
export async function routeMessage(
  message: any,
  sender: any,
  deps: RouterDeps
): Promise<any> {
  switch (message.type) {
    case 'PAGE_SCAN_RESULT':
      await deps.handleScanResult(message.payload, sender.tab?.id);
      return { received: true };

    case 'TRIGGER_SCAN_ALL': {
      const tabs = await deps.getOpenTrackedTabs();
      tabs.forEach(({ tab }) => {
        if (tab.id) browser.tabs.sendMessage(tab.id, { type: 'TRIGGER_SCAN' })
          .catch(err => logger.warn('msg', 'Failed to trigger scan on tab', err));
      });
      return { success: true, count: tabs.length };
    }

    case 'TOGGLE_MONITOR': {
      const { monitorStateStorage } = await import('./storage');
      const ms = await monitorStateStorage.getValue();
      if (!ms) return;
      const next = !ms.active;
      await monitorStateStorage.setValue({ ...ms, active: next });
      if (next) browser.alarms.create(deps.POLL_ALARM, { periodInMinutes: 15 });
      else browser.alarms.clear(deps.POLL_ALARM);
      await deps.updateBadge();
      return { success: true };
    }

    case 'START_MONITOR': {
      browser.alarms.create(deps.POLL_ALARM, { periodInMinutes: 15 });
      await deps.updateBadge();
      deps.syncRemoteSelectors().catch(err => logger.warn('msg', 'Failed to sync selectors', err));
      deps.connectSocket().catch(err => logger.warn('msg', 'Failed to connect socket', err));
      return { success: true };
    }

    case 'UPDATE_BADGE':
      await deps.updateBadge();
      return { received: true };

    case 'CLEAR_BADGE':
      await browser.action.setBadgeText({ text: '' });
      return { received: true };

    case 'ADD_TRACKED_SEARCH':
    case 'ADD_TRACKED_URL': {
      const url = message.url || message.payload?.url;
      if (!url) return;
      const normalized = normalizeCareerUrl(url);
      const pages = await trackedPagesStorage.getValue() || [];
      if (pages.find(p => p.normalizedUrl === normalized)) return { exists: true };
      pages.push({
        id: crypto.randomUUID(), url, normalizedUrl: normalized,
        label: extractReadableLabel(url).title, subtitle: extractReadableLabel(url).subtitle,
        addedAt: Date.now(), lastScrapedAt: null, lastScrapeStatus: 'pending', lastScrapeError: null,
        newJobCount: 0, isPending: false, platform: detectPlatform(url),
      });
      await trackedPagesStorage.setValue(pages);
      const userId = await deps.getUserId();
      const apiClient = new ApiClient(userId);
      apiClient.post('/api/tracked-searches', { url, platform: detectPlatform(url) })
        .catch(err => logger.warn('msg', 'Failed to sync tracked search', err));
      return { success: true };
    }

    case 'DELETE_TRACKED_SEARCH': {
      const pages = await trackedPagesStorage.getValue() || [];
      await trackedPagesStorage.setValue(pages.filter(p => p.id !== message.id));
      return { success: true };
    }

    case 'PREFS_UPDATED': {
      const profile = await profileStorage.getValue();
      if (profile && message.changes) {
        await profileStorage.setValue({ ...profile, ...message.changes, updatedAt: Date.now() });
        if (message.changes.watchlistCompanies) {
          deps.autoTrackCompanyPages(message.changes.watchlistCompanies)
            .catch(err => logger.error('auto-track', 'Failed to auto-track companies', err));
        }
      }
      return { success: true };
    }

    case 'MARK_JOB_SEEN': {
      const release = await deps.storageLock.acquire();
      try {
        const jobs = await unseenJobsStorage.getValue() || [];
        await unseenJobsStorage.setValue(jobs.map(j => j.id === message.jobId ? { ...j, seenAt: Date.now() } : j));
      } finally { release(); }
      await deps.updateBadge();
      return { success: true };
    }

    case 'MARK_ALL_SEEN': {
      const release = await deps.storageLock.acquire();
      try {
        const jobs = await unseenJobsStorage.getValue() || [];
        await unseenJobsStorage.setValue(jobs.map(j => j.seenAt ? j : { ...j, seenAt: Date.now() }));
      } finally { release(); }
      await deps.updateBadge();
      return { success: true };
    }

    case 'DISMISS_JOB': {
      const release = await deps.storageLock.acquire();
      try {
        const jobs = await unseenJobsStorage.getValue() || [];
        await unseenJobsStorage.setValue(jobs.map(j => j.id === message.jobId ? { ...j, dismissed: true } : j));
        const dismissed = await dismissedJobIdsStorage.getValue() || [];
        if (!dismissed.includes(message.jobId)) await dismissedJobIdsStorage.setValue([...dismissed, message.jobId]);
      } finally { release(); }
      await deps.updateBadge();
      return { success: true };
    }

    case 'SNOOZE_JOB': {
      const release = await deps.storageLock.acquire();
      try {
        const until = message.duration === 'tomorrow' ? Date.now() + 86400000 : Date.now() + 3600000;
        const jobs = await unseenJobsStorage.getValue() || [];
        await unseenJobsStorage.setValue(jobs.map(j => j.id === message.jobId ? { ...j, snoozedUntil: until } : j));
      } finally { release(); }
      return { success: true };
    }

    case 'PING': {
      const start = Date.now();
      const userId = await deps.getUserId();
      const apiClient = new ApiClient(userId);
      const { error, offline } = await apiClient.get('/api/health');
      const latency = Date.now() - start;
      if (offline) return { status: 'offline', latency: null };
      if (error) return { status: 'error', latency: null };
      return { status: 'ok', latency };
    }

    case 'GET_SOCKET_STATUS': {
      return { connected: deps.getSocketStatus() };
    }

    default:
      return undefined;
  }
}
