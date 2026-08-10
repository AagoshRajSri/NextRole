# Chrome Web Store Permissions Audit & Justification

This document details the MV3 permissions requested by the NextRole extension, mapping each permission to the exact user-facing feature it enables and justifying why it is the minimum required scope to comply with Chrome Web Store's least-privilege policy.

---

## Requested Manifest Permissions

| Permission | Feature Enabled | Least-Privilege Justification |
|---|---|---|
| `storage` | Storing user preferences, session flags, tracked searches, and caching job alert histories. | Required for `chrome.storage.local` to persist credentials/auth keys, user filters, and job matching configurations locally on the user's browser, as well as `chrome.storage.session` for passing parameters between popup and content scripts. |
| `notifications` | Notifying users when a match is found on an active or background-polled job page. | Enables native browser OS notifications. This allows the user to immediately see high-scoring, tailored matches even when they are working in another tab or program. |
| `alarms` | Keeping the background service worker alive and checking the backend periodically for matched jobs. | Required to trigger background tasks and updates. Alarms are configured for a 15-minute background job poll (`POLL_JOBS`), a 5-minute active LinkedIn scanning loop (`LINKEDIN_PAGES_SCAN`), and a 1440-minute daily cleanup task (`DAILY_PRUNE`). |
| `tabs` | Creating new tabs for job details, opening the onboarding dashboard, and checking tab states. | Used to programmatically check URL paths of open windows via `chrome.tabs.query` to detect if the user is currently on an ATS/job listing page, and to open the onboarding setup wizard page. |
| `scripting` | Executing the scanning content script programmatically on ATS job sites. | Allows the background service worker to inject `content.js` dynamically when a user triggers manual scanning from the popup interface. |
| `activeTab` | Temporary site access for generic job-board scanning. | Used for any career site not in our supported ATS list, including major company career pages, triggered only when the user clicks the extension on that tab. This avoids broad wildcard read permissions across all web domains. |
| `downloads` | Exporting job-matching history and tracking lists to JSON/CSV files. | Enables the user to back up, export, and download their tracked search logs locally to a JSON file. |

---

## Requested Host Permissions

| Host Pattern | Target Platform(s) | Justification |
|---|---|---|
| `https://www.linkedin.com/*` | LinkedIn Job Search | Allows content scripts to read and match target job postings in the user's active viewport on LinkedIn. |
| `https://boards.greenhouse.io/*`, `https://*.greenhouse.io/*` | Greenhouse ATS | Allows content-script matching on Greenhouse boards. |
| `https://jobs.lever.co/*` | Lever ATS | Allows content-script matching on Lever boards. |
| `https://*.myworkdayjobs.com/*`, `https://*.myworkday.com/*` | Workday ATS | Allows content-script matching on Workday's job boards. |
| `https://jobs.ashbyhq.com/*` | Ashby ATS | Allows content-script matching on Ashby boards. |
| `https://amazon.jobs/*`, `https://careers.amazon.com/*` | Amazon Jobs | Allows content-script matching on Amazon's career site. |
| `https://www.naukri.com/*` | Naukri Job Board | Allows content-script matching on Naukri search pages. |
| `https://jobs.smartrecruiters.com/*` | SmartRecruiters | Allows content-script matching on SmartRecruiters. |
| `https://*.icims.com/*` | iCIMS ATS | Allows content-script matching on iCIMS job boards. |
| `https://*.taleo.net/*` | Taleo ATS | Allows content-script matching on Taleo job boards. |
| `https://careers.google.com/*`, `https://www.google.com/about/careers/*` | Google Careers | Allows content-script matching on Google's job search page. |
| `https://jobs.apple.com/*` | Apple Careers | Allows content-script matching on Apple's career search pages. |
| `https://api.nextrole.ai/*` | Production Backend API | Allows backend syncing, auth, profile configurations, and NLP matching requests in production environments. |

---

## Removed Permissions (Cleaned in Audit)

* `cookies`: Unused. Session cookie capturing has been completely decoupled from the extension flow.
* `webNavigation`: Unused. Navigations are tracked efficiently using direct `chrome.tabs.onUpdated` event listeners.

---

## Remote Code Compliance

NextRole is fully compliant with Chrome Web Store's Manifest V3 Remote Code Execution policies:

1. **No Executable Code Injection / Evaluation**: A recursive codebase audit confirms that the extension uses **zero** occurrences of `eval()`, `new Function()`, or dynamic `<script>` element injection.
2. **Data-Only Remote Config**: The remote selectors synced from `/api/selectors` return strictly structured JSON data (CSS class/attribute target configurations for Greenhouse, Lever, etc.). This data is utilized exclusively as parameter inputs to browser DOM lookup APIs (`document.querySelector` and `document.querySelectorAll`), and is never parsed or executed as runtime JavaScript.
3. **Strict DOM XSS Prevention**: Any job information scraped from active tabs or retrieved from background syncs (e.g. job titles, company names, locations) is strictly sanitized. Variables are routed through the extension's native HTML escaper (which translates strings using browser-native `textContent` text nodes) before they are bound to the DOM, ensuring that raw HTML tags or inline event handlers are rendered as harmless text.
