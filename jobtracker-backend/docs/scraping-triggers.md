# Scraper Code Paths & Automation Trigger Map

This document outlines every code path in the NextRole backend that invokes Playwright or custom scrapers (`BrowserFactory.getPage()` or `fetchPublicJobs()`). It establishes strict compliance boundaries regarding unattended background sweeps versus user-initiated extension scans.

---

## Trigger Categories Legend
* **(a) Unattended Cron:** Scheduled background queue worker (BullMQ `monitorQueue` running 15-minute polling).
* **(b) Extension "Check Now" / Live-Tab Scan:** Direct, user-initiated action within the WXT extension live tab.
* **(c) Resume Tailoring:** Direct user request to `POST /api/resumes/tailor` for tailoring a specific job.
* **(d) CLI / Developer Utility:** Standalone manual test scripts (`test-scraper.ts`, `test-scraper-batch.ts`).

---

## Scraper Execution Map

| Module / Function | Call Site | Target Platform(s) | Trigger Type | Unattended Cron Allowed? | Policy & Audit Notes |
|---|---|---|---|---|---|
| `fetchPublicJobs()` | `worker.ts` | Greenhouse, Lever, Ashby, Workday (JSON feeds) | (a) Unattended Cron | **Yes** | Uses public, unauthenticated JSON API feeds. No HTML rendering or browser automation used. |
| `scrapeLinkedIn()` | `scraper.ts:239` | LinkedIn (`linkedin`) | (b) Live-Tab Scan / (d) CLI | ❌ **NO (Blocked in Worker)** | Unattended cron scraping is explicitly prohibited. Background cron checks skip LinkedIn URLs with status `skipped`. Scanning is allowed only via live extension tab. |
| `scrapeGoogleCareers()` | `scraper.ts:143` | Google Careers (`google`) | (b) Live-Tab Scan / (d) CLI | ❌ **NO (Blocked in Worker)** | Google `robots.txt` disallows automated crawler access. Background cron checks skip `google` URLs with status `skipped`. |
| `scrapeAmazonJobs()` | `scraper.ts:197` | Amazon Jobs (`amazon_jobs`) | (b) Live-Tab Scan / (d) CLI | ❌ **NO (Blocked in Worker)** | Amazon Jobs `robots.txt` prohibits automated scraping. Background cron checks skip `amazon_jobs` URLs with status `skipped`. |
| `scrapeTaleo()` | `scraper.ts:281` | Taleo (`taleo`) | (a) Unattended Cron / (b) Live-Tab | **Yes** | HTML scraping fallback for unauthenticated public ATS job listings. |
| `scrapeNaukri()` | `scraper.ts:471` | Naukri (`naukri`) | (a) Unattended Cron / (b) Live-Tab | **Yes** | Scrapes public search listings. |
| `scrapeApple()` | `scraper.ts:100` | Apple Jobs (`apple`) | (a) Unattended Cron / (b) Live-Tab | **Yes** | Scrapes public search listings. |
| `scrapeWorkday()` | `scraper.ts:634` | Workday (`workday`) | (a) Unattended Cron / (b) Live-Tab | **Yes** | Fallback HTML scraper when public feed is unavailable. |
| `scrapeSmartRecruiters()` | `scraper.ts:719` | SmartRecruiters (`smartrecruiters`) | (a) Unattended Cron / (b) Live-Tab | **Yes** | Fallback HTML scraper when public feed is unavailable. |
| `scrapeIcims()` | `scraper.ts:794` | iCIMS (`icims`) | (a) Unattended Cron / (b) Live-Tab | **Yes** | Fallback HTML scraper. |
| `scrapeGeneric()` | `scraper.ts:328` | Generic career pages | (a) Unattended Cron / (b) Live-Tab | **Yes** | Standard HTML link & JSON-LD parser fallback. |
| `scrapeFullJobDescription()` | `worker.ts:393` | Any Job Posting URL | (c) Resume Tailoring | ❌ **NO** | Removed from background cron worker. Executed solely on explicit user request for AI resume tailoring. |

---

## Verification & Compliance Rules

1. **LinkedIn Security Boundary:** LinkedIn automated background sweeps are strictly prevented in `worker.ts`. Any `trackedSearch` pointing to LinkedIn is marked as `skipped` in background worker sweeps.
2. **Robots.txt & Terms Policy:** `google` and `amazon_jobs` are treated identically to `linkedin` for background cron tasks due to explicit crawler prohibitions in their site policies.
3. **Resume Tailoring Isolation:** AI resume tailoring and full job description parsing (`scrapeFullJobDescription`) never run automatically during cron job ingest.
