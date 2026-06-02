// ────────────────────────────────────────────────────────
// NOTIFICATION MANAGER
// Extracted from background.ts for separation of concerns.
// ────────────────────────────────────────────────────────

import { browser } from 'wxt/browser';
import type { StoredJob } from './storage';
import { logger } from './logger';

/**
 * Fire OS-level notifications for newly matched jobs.
 * Always fires if the user is onboarded — alertMode only controls *email* frequency.
 */
export async function fireNotifications(newJobs: StoredJob[], profile: { isOnboarded?: boolean }): Promise<void> {
  if (!profile.isOnboarded) return;
  const worthy = newJobs.filter(j => (j.matchScore ?? 100) >= 40);
  if (worthy.length === 0) return;

  if (worthy.length === 1) {
    const job = worthy[0];
    const notifId = `job-${job.id}`;
    await browser.notifications.create(notifId, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: `🔔 ${job.title.slice(0, 45)}`,
      message: `${job.companyName || 'New match'} · ${job.location || 'See listing'}`,
      contextMessage: 'NextRole — Click to view',
      requireInteraction: false,
      buttons: [{ title: '📋 Open job' }, { title: '😴 Snooze 1h' }],
    });
    await storePendingNotification(notifId, job.url);
    browser.alarms.create(`notif-keepalive-${notifId}`, { delayInMinutes: 0.5 });
  } else {
    await browser.notifications.create(`digest-${Date.now()}`, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: `🔔 ${worthy.length} new job matches!`,
      message: worthy.slice(0, 3).map(j => `• ${j.title} @ ${j.companyName}`).join('\n'),
      contextMessage: 'NextRole — Click to open extension',
      requireInteraction: false,
    });
  }
  logger.info('notifications', `Fired notification for ${worthy.length} job(s)`);
}

/**
 * Store a pending notification in session storage so we can resolve
 * the job URL when the user clicks the notification button.
 */
export async function storePendingNotification(notifId: string, jobUrl: string): Promise<void> {
  try {
    const pending = await browser.storage.session.get('pendingNotifications') as Record<string, any>;
    const map = pending.pendingNotifications || {};
    map[notifId] = { jobUrl, createdAt: Date.now() };
    await browser.storage.session.set({ pendingNotifications: map });
  } catch (err) {
    logger.warn('notifications', 'Failed to store pending notification', err);
  }
}

/**
 * Retrieve and clear a pending notification entry.
 */
export async function getPendingNotification(notifId: string): Promise<{ jobUrl: string } | null> {
  try {
    const pending = await browser.storage.session.get('pendingNotifications') as Record<string, any>;
    return pending.pendingNotifications?.[notifId] ?? null;
  } catch (err) {
    logger.warn('notifications', 'Failed to get pending notification', err);
    return null;
  }
}

/**
 * Remove a consumed notification entry from session storage.
 */
export async function clearPendingNotification(notifId: string): Promise<void> {
  try {
    const pending = await browser.storage.session.get('pendingNotifications') as Record<string, any>;
    const updated = { ...(pending.pendingNotifications || {}) };
    delete updated[notifId];
    await browser.storage.session.set({ pendingNotifications: updated });
  } catch (err) {
    logger.warn('notifications', 'Failed to clear pending notification', err);
  }
}
