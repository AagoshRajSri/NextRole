export const CONFIG = {
  // In production: this is replaced at build time by WXT's env handling
  // In development: uses localhost
  API_BASE_URL: import.meta.env.WXT_API_BASE_URL || 'http://localhost:5000',
  
  // Feature flags (can be overridden per environment)
  ENABLE_BACKEND_SYNC: import.meta.env.WXT_ENABLE_BACKEND_SYNC !== 'false',
  POLL_INTERVAL_MINUTES: Number(import.meta.env.WXT_POLL_INTERVAL) || 15,
};
