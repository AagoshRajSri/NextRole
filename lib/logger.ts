import { browser } from 'wxt/browser';

const LOG_KEY = 'local:activityLogs';
const MAX_LOGS = 100;

interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  context: string;
  message: string;
  data?: unknown;
}

export const logger = {
  async log(level: LogEntry['level'], context: string, message: string, data?: unknown) {
    const entry: LogEntry = { timestamp: Date.now(), level, context, message, data };
    
    // Always console log
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    method(`[NextRole:${context}]`, message, data || '');
    
    // Persist all logs to storage for the Activity Logs Console
    try {
      const existing = await browser.storage.local.get(LOG_KEY) as Record<string, any>;
      const log: LogEntry[] = existing[LOG_KEY] || [];
      log.unshift(entry);
      await browser.storage.local.set({ [LOG_KEY]: log.slice(0, MAX_LOGS) });
    } catch {}  // never throw from logger
  },
  
  info: (ctx: string, msg: string, data?: unknown) => logger.log('info', ctx, msg, data),
  warn: (ctx: string, msg: string, data?: unknown) => logger.log('warn', ctx, msg, data),
  error: (ctx: string, msg: string, data?: unknown) => logger.log('error', ctx, msg, data),
  getLogs: async (): Promise<LogEntry[]> => {
    try {
      const data = await browser.storage.local.get(LOG_KEY) as Record<string, any>;
      return data[LOG_KEY] || [];
    } catch { return []; }
  },
  clearLogs: async () => {
    await browser.storage.local.remove(LOG_KEY);
  }
};
