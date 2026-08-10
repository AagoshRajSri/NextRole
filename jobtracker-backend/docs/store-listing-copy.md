# Chrome Web Store Developer Dashboard Justification Copy

This file contains the exact text and copy blocks required for fields in the Chrome Web Store Developer Dashboard during extension submission.

---

## 1. Single-Purpose Description
> **Dashboard Field:** *Detailed Description / Single Purpose*

NextRole is an AI-powered careers co-pilot designed to monitor job postings on supported Applicant Tracking Systems (ATS) and job boards, automatically calculating match scores and tailoring resumes against the user's saved professional profile. Its single purpose is to streamline job search tracking and profile-to-job compatibility analysis directly within the browser.

---

## 2. API Permissions Justifications
> **Dashboard Field:** *Permission Justification / Why is this permission needed?*

### `storage`
* **Justification:** Used to store user matching filters, job tracking history, and session flags locally in the browser. This allows the extension to remember the user's preferences and past match results across sessions without requiring remote data storage for basic utility.

### `notifications`
* **Justification:** Used to trigger native desktop notifications when the extension identifies a high-compatibility job matching the user's criteria. This ensures the user is immediately alerted to relevant opportunities without needing to keep the extension popup constantly open.

### `alarms`
* **Justification:** Used to run background synchronization tasks and checks. The alarms are configured for a 15-minute background job poll (`POLL_JOBS`), a 5-minute active LinkedIn scanning loop (`LINKEDIN_PAGES_SCAN`), and a 1440-minute daily cleanup task (`DAILY_PRUNE`).

### `tabs`
* **Justification:** Used to query the URL and title of active browser windows to detect if the user is currently viewing a supported job board or Applicant Tracking System (ATS). It is also used to programmatically open the onboarding setup guide after installation.

### `scripting`
* **Justification:** Used to inject and execute the page scanner content script on supported job search pages. This enables the extension to read the text of job postings visible in the active tab to extract titles, locations, and company names.

### `activeTab`
* **Justification:** Used to scan job postings on generic corporate career portals when the user explicitly clicks the extension icon. This limits host access to only the tab currently in focus, avoiding the need for broad wildcard read permissions on all websites.

### `downloads`
* **Justification:** Used to export the user's history of matches and tracked postings into a local backup file (JSON format) directly to their local downloads folder. No files are downloaded or modified without direct user interaction in the popup.

---

## 3. Host Permissions Justifications
> **Dashboard Field:** *Host Permissions / Justification for site access*

*Note: For all host permissions below, fetched data is used strictly for parsing text to perform semantic matching and displaying scoring results in the popup interface. Fetch results are never executed, evaluated (`eval()`), or injected as executable code.*

### `https://www.linkedin.com/*`
* **Justification:** Enables the extension to analyze job listing details in the user's viewport on LinkedIn when navigating job search results, providing instant fit scores.

### `https://boards.greenhouse.io/*` and `https://*.greenhouse.io/*`
* **Justification:** Enables the extension to analyze and extract posting details from Greenhouse boards.

### `https://jobs.lever.co/*`
* **Justification:** Enables the extension to read posting details from Lever-hosted jobs.

### `https://*.myworkdayjobs.com/*` and `https://*.myworkday.com/*`
* **Justification:** Enables the extension to read job titles and descriptions on company Workday boards to calculate compatibility and tailors details.

### `https://jobs.ashbyhq.com/*`
* **Justification:** Enables the extension to query Ashby GraphQL job postings and parse descriptions on Ashby pages.

### `https://amazon.jobs/*` and `https://careers.amazon.com/*`
* **Justification:** Enables the extension to read and score listings on Amazon's career site.

### `https://www.naukri.com/*`
* **Justification:** Enables the extension to read and score jobs on Naukri search listings.

### `https://jobs.smartrecruiters.com/*`
* **Justification:** Enables the extension to read job postings on SmartRecruiters boards.

### `https://*.icims.com/*`
* **Justification:** Enables the extension to read corporate job descriptions hosted on the iCIMS ATS framework.

### `https://*.taleo.net/*`
* **Justification:** Enables the extension to read corporate job descriptions hosted on the Taleo ATS framework.

### `https://careers.google.com/*` and `https://www.google.com/about/careers/*`
* **Justification:** Enables the extension to read job titles and descriptions on Google's career search pages.

### `https://jobs.apple.com/*`
* **Justification:** Enables the extension to read job titles and descriptions on Apple's career search pages.

### `https://api.nextrole.ai/*`
* **Justification:** Allows the extension to communicate with the production API server for authentication, profile syncing, and compatibility scoring.
