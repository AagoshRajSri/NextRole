const LOG_KEY = 'local:errorLog';
const MAX_ERRORS = 50;

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
    
    // Persist errors to storage for Settings tab "View logs" feature
    if (level === 'error') {
      try {
        const existing = await chrome.storage.local.get(LOG_KEY);
        const log: LogEntry[] = existing[LOG_KEY] || [];
        log.unshift(entry);
        await chrome.storage.local.set({ [LOG_KEY]: log.slice(0, MAX_ERRORS) });
      } catch {}  // never throw from logger
    }
  },
  
  info: (ctx: string, msg: string, data?: unknown) => logger.log('info', ctx, msg, data),
  warn: (ctx: string, msg: string, data?: unknown) => logger.log('warn', ctx, msg, data),
  error: (ctx: string, msg: string, data?: unknown) => logger.log('error', ctx, msg, data),
};
