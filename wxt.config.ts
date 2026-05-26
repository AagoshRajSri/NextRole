import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  
  // Source maps in dev only
  vite: () => ({
    build: {
      sourcemap: process.env.NODE_ENV === 'development' ? 'inline' : false,
      minify: process.env.NODE_ENV === 'production' ? 'esbuild' : false,
    }
  }),
  
  manifest: {
    name: 'NextRole — Job Intelligence Co-pilot',
    version: '1.0.0',
    description: 'Instant job alerts on LinkedIn, Greenhouse, Lever & more. Be first to apply.',
    
    // Minimum version — ensures Promises work in service worker
    minimum_chrome_version: '116',
    
    icons: {
      '16': 'icon/16.png',
      '32': 'icon/32.png',
      '48': 'icon/48.png',
      '128': 'icon/128.png',
    },
    
    permissions: [
      'storage',
      'notifications',
      'alarms',
      'tabs',
      'scripting',
      'activeTab',
      'downloads',
    ],
    
    host_permissions: [
      'https://www.linkedin.com/*',
      'https://boards.greenhouse.io/*',
      'https://jobs.lever.co/*',
      'https://*.myworkdayjobs.com/*',
      'https://jobs.ashbyhq.com/*',
      'https://amazon.jobs/*',
      'https://wellfound.com/*',
      'https://*.workable.com/*',
      'https://www.naukri.com/*',
      'https://www.instahyre.com/*',
      'https://jobs.microsoft.com/*',
      'https://careers.crowdstrike.com/*',
      'https://careers.cloudflare.com/*',
      'https://datadog.com/*',
      'https://*.greenhouse.io/*',
      'https://apply.workable.com/*',
      'https://jobs.smartrecruiters.com/*',
      // Enterprise ATS platforms
      "https://*.eightfold.ai/*",
      "https://*.taleo.net/*",
      "https://*.icims.com/*",
      "https://*.successfactors.com/*",
      "https://*.successfactors.eu/*",
      "https://*.jobvite.com/*",
      "https://*.brassring.com/*",
      "https://*.myworkday.com/*",
      "https://*.ultipro.com/*",
      "https://*.ukg.com/*",
      // Well-known company career pages
      "https://careers.google.com/*",
      "https://www.google.com/about/careers/*",
      "https://jobs.apple.com/*",
      "https://www.metacareers.com/*",
      "https://careers.microsoft.com/*",
      "https://careers.amazon.com/*",
      "https://netflix.com/jobs/*",
      "https://jobs.netflix.com/*",
      "https://stripe.com/jobs/*",
      "https://careers.stripe.com/*",
      "https://vercel.com/careers/*",
      "https://airbnb.com/careers/*",
      "https://careers.airbnb.com/*",
      "https://careers.shopify.com/*",
      "https://careers.databricks.com/*",
      "https://careers.openai.com/*",
      "https://www.anthropic.com/careers/*",
      "https://careers.figma.com/*",
      "https://careers.notion.so/*",
      "https://careers.hubspot.com/*",
      "https://careers.salesforce.com/*",
      "https://careers.adobe.com/*",
      "https://careers.oracle.com/*",
      "https://careers.cisco.com/*",
      "https://jobs.boeing.com/*",
      "https://careers.infosys.com/*",
      "https://careers.wipro.com/*",
      "https://ibegin.tcs.com/*",
      "https://careers.hcltech.com/*",
      "https://careers.swiggy.com/*",
      "https://www.zomato.com/careers/*",
      "https://www.flipkartcareers.com/*",
      'http://localhost:5000/*'
    ],
    
    // Action popup
    action: {
      default_popup: 'popup/index.html',
      default_title: 'NextRole',
      default_icon: { '16': 'icon/16.png', '32': 'icon/32.png' },
    },
    
    // Content scripts only on known ATS domains (not broad wildcards)
    content_scripts: [
      {
        matches: [
          'https://www.linkedin.com/company/*/jobs*',
          'https://www.linkedin.com/jobs/*',
          'https://boards.greenhouse.io/*',
          'https://*.greenhouse.io/*',
          'https://jobs.lever.co/*',
          'https://*.myworkdayjobs.com/*',
          'https://jobs.ashbyhq.com/*',
          'https://amazon.jobs/*',
          'https://wellfound.com/*',
          'https://apply.workable.com/*',
          'https://www.naukri.com/*',
          'https://www.instahyre.com/*',
          'https://jobs.microsoft.com/*',
          'https://careers.crowdstrike.com/*',
          'https://careers.cloudflare.com/*',
          'https://jobs.smartrecruiters.com/*',
          "https://*.eightfold.ai/*",
          "https://*.taleo.net/*",
          "https://*.icims.com/*",
          "https://*.successfactors.com/*",
          "https://*.successfactors.eu/*",
          "https://*.jobvite.com/*",
          "https://*.brassring.com/*",
          "https://*.myworkday.com/*",
          "https://*.ultipro.com/*",
          "https://*.ukg.com/*",
          "https://careers.google.com/*",
          "https://www.google.com/about/careers/*",
          "https://jobs.apple.com/*",
          "https://www.metacareers.com/*",
          "https://careers.microsoft.com/*",
          "https://careers.amazon.com/*",
          "https://netflix.com/jobs/*",
          "https://jobs.netflix.com/*",
          "https://stripe.com/jobs/*",
          "https://careers.stripe.com/*",
          "https://vercel.com/careers/*",
          "https://airbnb.com/careers/*",
          "https://careers.airbnb.com/*",
          "https://careers.shopify.com/*",
          "https://careers.databricks.com/*",
          "https://careers.openai.com/*",
          "https://www.anthropic.com/careers/*",
          "https://careers.figma.com/*",
          "https://careers.notion.so/*",
          "https://careers.hubspot.com/*",
          "https://careers.salesforce.com/*",
          "https://careers.adobe.com/*",
          "https://careers.oracle.com/*",
          "https://careers.cisco.com/*",
          "https://jobs.boeing.com/*",
          "https://careers.infosys.com/*",
          "https://careers.wipro.com/*",
          "https://ibegin.tcs.com/*",
          "https://careers.hcltech.com/*",
          "https://careers.swiggy.com/*",
          "https://www.zomato.com/careers/*",
          "https://www.flipkartcareers.com/*"
        ],
        js: ['content-scripts/content.js'],
        run_at: 'document_idle',
        all_frames: false,
      }
    ],
    
    commands: {
      '_execute_action': {
        suggested_key: { default: 'Alt+Shift+N', mac: 'Alt+Shift+N' },
        description: 'Open NextRole',
      }
    },
    
    web_accessible_resources: [
      {
        resources: ['icons/*.png', 'fonts/*.woff2'],
        matches: ['<all_urls>'],
      }
    ],
  },
});
