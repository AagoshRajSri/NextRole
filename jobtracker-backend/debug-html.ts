import { chromium } from 'playwright';

async function debug() {
  const url = 'https://jobs.lever.co/palantir';
  console.log(`[Debug] Launching browser to inspect: ${url}`);
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  
  const page = await context.newPage();
  
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`[Debug] Page loaded. HTTP Status: ${response?.status()}`);
    console.log(`[Debug] Title: ${await page.title()}`);
    
    // Check if Cloudflare is blocking
    const bodyText = await page.innerText('body');
    if (bodyText.includes('checking your browser') || bodyText.includes('cloudflare') || bodyText.includes('enable javascript')) {
      console.log('[Debug] WARNING: Bot protection / Cloudflare challenge page detected!');
    } else {
      console.log('[Debug] Page loaded normally without Cloudflare challenge.');
      
      // Let's print out the classes of some elements in the page
      const elementsSample = await page.evaluate(() => {
        const divs = Array.from(document.querySelectorAll('div'));
        const classes = new Set();
        divs.forEach(d => {
          if (d.className) classes.add(d.className);
        });
        
        const anchors = Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.innerText.trim().substring(0, 30),
          href: a.getAttribute('href'),
          parentClass: a.parentElement?.className || ''
        })).slice(0, 15);
        
        return {
          totalDivs: divs.length,
          allClasses: Array.from(classes).slice(0, 30),
          first15Anchors: anchors
        };
      });
      
      console.log('[Debug] Elements metadata:');
      console.log(JSON.stringify(elementsSample, null, 2));
    }
  } catch (e) {
    console.error('[Debug] Error loading page:', e);
  } finally {
    await browser.close();
  }
}

debug();
