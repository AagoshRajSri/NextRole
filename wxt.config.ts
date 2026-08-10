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
      'https://*.greenhouse.io/*',
      'https://jobs.lever.co/*',
      'https://*.myworkdayjobs.com/*',
      'https://*.myworkday.com/*',
      'https://jobs.ashbyhq.com/*',
      'https://amazon.jobs/*',
      'https://careers.amazon.com/*',
      'https://www.naukri.com/*',
      'https://jobs.smartrecruiters.com/*',
      'https://*.icims.com/*',
      'https://*.taleo.net/*',
      'https://careers.google.com/*',
      'https://www.google.com/about/careers/*',
      'https://jobs.apple.com/*',
      // PRODUCTION API DOMAIN - Do not submit the extension to the Chrome Web Store with localhost!
      // Localhost host permissions will be rejected. Always use the production API domain.
      'https://api.nextrole.ai/*'
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
          'https://www.naukri.com/*',
          'https://jobs.smartrecruiters.com/*',
          'https://*.icims.com/*',
          'https://*.taleo.net/*',
          'https://careers.google.com/*',
          'https://www.google.com/about/careers/*',
          'https://jobs.apple.com/*',
          'https://careers.amazon.com/*'
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
