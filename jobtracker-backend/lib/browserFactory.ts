import { chromium, Browser, BrowserContext, Page } from 'playwright'

// A single, minimal User-Agent so servers can identify the client if needed.
// We do not spoof properties or inject scripts to evade bot detection.
const USER_AGENT =
  'Mozilla/5.0 (compatible; NextRole-Bot/1.0; +https://github.com/AagoshRajSri/NextRole)'

export interface BrowserOptions {
  headed?: boolean       // show the browser window (for local debugging)
  sessionDir?: string    // path to a saved storage-state file (Playwright format)
  proxy?: string         // http://user:pass@host:port
  timeout?: number       // navigation timeout in ms (default: 30000)
  disableResourceBlocking?: boolean // keep images/fonts enabled when true
}

export class BrowserFactory {
  static async getPage(options: BrowserOptions = {}): Promise<{
    page: Page
    context: BrowserContext
    cleanup: () => Promise<void>
  }> {
    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: !options.headed,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }

    if (options.proxy) {
      launchOptions.proxy = { server: options.proxy }
    }

    const contextOptions: Parameters<Browser['newContext']>[0] = {
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    }

    if (options.sessionDir) {
      contextOptions.storageState = options.sessionDir
    }

    const browser = await chromium.launch(launchOptions)
    const context = await browser.newContext(contextOptions)

    const page = await context.newPage()

    // Block heavy media and known analytics trackers to keep scraping fast,
    // but only when resource blocking is enabled (the default).
    if (!options.disableResourceBlocking) {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType()
        const url  = route.request().url()

        const blockedTrackers = [
          'google-analytics', 'googletagmanager', 'facebook.net', 'doubleclick',
          'hotjar', 'fullstory', 'heap-api', 'segment.io', 'mixpanel',
          'amplitude', 'intercom', 'zendesk',
        ]

        if (
          type === 'media' ||
          (type === 'image' && !url.includes('favicon')) ||
          (type === 'font') ||
          blockedTrackers.some(t => url.includes(t))
        ) {
          route.abort()
        } else {
          route.continue()
        }
      })
    }

    page.setDefaultTimeout(options.timeout ?? 30000)
    page.setDefaultNavigationTimeout(options.timeout ?? 30000)

    const cleanup = async () => {
      await page.close().catch(() => {})
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    }

    return { page, context, cleanup }
  }
}
