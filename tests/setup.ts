import { fakeBrowser } from 'wxt/testing';

// Initialize fake browser environment for WXT storage in tests
(globalThis as any).chrome = fakeBrowser;
(globalThis as any).browser = fakeBrowser;
