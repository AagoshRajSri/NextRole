# NextRole Privacy Policy

**Effective Date:** August 10, 2026

NextRole ("we", "us", "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, store, and share your data when you use the NextRole extension and matching platform.

---

## 1. Data Collection Inventory

We only collect data that is strictly necessary to provide the job monitoring, compatibility scoring, and resume-tailoring features of NextRole:

* **Account Email:** Used for registration, secure authentication, and account-related updates.
* **Hashed Password:** Used to authenticate your login. We hash passwords using bcrypt before saving them; we never store plain-text passwords.
* **Tracked Search Configuration:** The specific career page URLs and platforms (e.g. Greenhouse, Lever, Ashby) you choose to track.
* **Job Snapshots:** Metadata of job listings discovered on your tracked searches, including job titles, locations, URLs, company names, first seen timestamps, and match statuses.
* **Resume Text:** User-provided resume data (experience, skills, projects, and education) used to generate tailored resumes.
* **Embeddings:** Mathematical vector representations of your professional profile and job listings, generated solely to perform semantic compatibility scoring.
* **JWT Tokens:** Locally stored browser-session tokens used to securely authenticate requests from the extension to the NextRole backend.

---

## 2. What We DO NOT Collect

To maintain a zero-intrusion policy, NextRole explicitly does not collect or access:
* **No Third-Party Session Cookies:** We do not capture, intercept, or store session cookies from LinkedIn, Workday, Greenhouse, or any other third-party job site.
* **No Third-Party Credentials:** We never request or store your passwords or login credentials for third-party websites.
* **No General Browsing History:** We do not monitor or record your browsing activity outside of the specific job search pages you actively choose to track or scan.

---

## 3. Data Storage & Security

* **Database Storage:** All profile, search configuration, and job match data is stored securely in our PostgreSQL database.
* **Password Hashing:** User passwords are encrypted on write using one-way cryptographic hashing (bcrypt).
* **Network Security:** All communication between the NextRole extension and the backend API is encrypted in transit using standard HTTPS/TLS.

---

## 4. Third-Party Data Sharing

We do not sell, rent, or trade your personal data. To provide specific AI features, we share data with the following processor:
* **AWS Bedrock:** When you explicitly request to tailor a resume for a specific job, the job description and your resume text are sent to **AWS Bedrock** (running Claude models). This data is processed in accordance with AWS security policies and is never used to train public models.

---

## 5. Retention & User Data Deletion

* **Retention Period:** We retain your account data and match logs for as long as your account remains active.
* **Complete Account Deletion:** You have the right to delete your account and all associated data at any time. This can be done via the extension settings or by sending a request to the `DELETE /api/account` endpoint. This operation cascades across our databases and permanently deletes your:
  1. User Profile details and resume text.
  2. Tracked Search configurations.
  3. All Job Snapshots and historical match logs.
  4. All generated Tailored Resumes.
  5. Subscription metadata.

---

## 6. Contact & Compliance

If you have any questions about this Privacy Policy or wish to exercise your data rights, please contact us at privacy@nextrole.ai.
