import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { chromium as chromiumExtra } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

chromiumExtra.use(StealthPlugin())

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
]

export interface BrowserOptions {
  headed?: boolean           // show browser window (for debugging)
  stealth?: boolean          // use playwright-extra stealth (default: true)
  sessionDir?: string        // persist cookies/session to this directory
  proxy?: string             // http://user:pass@host:port
  timeout?: number           // navigation timeout in ms (default: 30000)
  disableResourceBlocking?: boolean // if true, don't block images/fonts
  cookies?: Array<Record<string, any>> // raw browser cookies to inject (for auth bypass)
}

export class BrowserFactory {
  private static instance: Browser | null = null

  static async getPage(options: BrowserOptions = {}): Promise<{
    page: Page
    context: BrowserContext
    cleanup: () => Promise<void>
  }> {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    const vp = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)]

    const launchOptions: any = {
      headless: !options.headed,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-infobars',
        '--window-size=1920,1080',
      ],
    }

    if (options.proxy) {
      launchOptions.proxy = { server: options.proxy }
    }

    const contextOptions: any = {
      userAgent: ua,
      viewport: vp,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: ['notifications'],
      // Realistic browser fingerprint fields
      colorScheme: 'light',
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      javaScriptEnabled: true,
    }

    if (options.sessionDir) {
      contextOptions.storageState = options.sessionDir
    }

    const launcher = options.stealth !== false ? chromiumExtra : chromium
    const browser = await launcher.launch(launchOptions)
    const context = await browser.newContext(contextOptions)

    // Inject session cookies for auth-wall bypass (e.g. LinkedIn logged-in state)
    if (options.cookies && options.cookies.length > 0) {
      const cookiesToInject = options.cookies
        .filter(c => c.name && c.value)
        .map(c => ({
          name: String(c.name),
          value: String(c.value),
          domain: String(c.domain || '.linkedin.com'),
          path: String(c.path || '/'),
          // Chrome uses expirationDate (float seconds), Playwright uses expires (int seconds)
          expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          sameSite: 'None' as const,
        }));
      await context.addCookies(cookiesToInject).catch(e =>
        console.warn('[BrowserFactory] Cookie injection failed (non-fatal):', (e as Error).message)
      );
      console.log(`[BrowserFactory] Injected ${cookiesToInject.length} session cookies.`);
    }

    // Inject anti-detection scripts into every page
    await context.addInitScript(() => {
      // Overwrite the `navigator.webdriver` property to be undefined
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      
      // Override plugins length to be realistic
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      
      // Override languages
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      
      // Mock chrome object
      ;(window as any).chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {},
      }
      
      // Override permissions query
      const originalQuery = window.navigator.permissions.query
      ;(window.navigator.permissions as any).query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
    })

    const page = await context.newPage()
    
    // Block unnecessary resources to speed up scraping
    if (!options.disableResourceBlocking) {
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType()
        const url = route.request().url()
        
        // Block tracking, analytics, and heavy media
        const blocked = [
          'google-analytics', 'googletagmanager', 'facebook.net', 'doubleclick',
          'hotjar', 'fullstory', 'heap-api', 'segment.io', 'mixpanel',
          'amplitude', 'intercom', 'zendesk',
        ]
        
        if (
          resourceType === 'media' ||
          (resourceType === 'image' && !url.includes('favicon')) ||
          (resourceType === 'font' && !url.includes('linkedin')) ||
          blocked.some(b => url.includes(b))
        ) {
          route.abort()
        } else {
          route.continue()
        }
      })
    }

    page.setDefaultTimeout(options.timeout || 30000)
    page.setDefaultNavigationTimeout(options.timeout || 30000)

    const cleanup = async () => {
      await page.close().catch(() => {})
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    }

    return { page, context, cleanup }
  }
}
