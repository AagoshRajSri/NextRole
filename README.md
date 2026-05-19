# ⚡ NextRole — Never Miss Out⚡

<div align="center">
  <p><strong>A high-fidelity, autonomous ATS scraping co-pilot and real-time career monitoring terminal.</strong></p>

  [![WXT](https://img.shields.io/badge/Extension-WXT_MV3-00f0ff?style=for-the-badge&logo=googlechrome&logoColor=white)](https://wxt.dev/)
  [![Backend](https://img.shields.io/badge/Backend-Express.js-f0ff00?style=for-the-badge&logo=express&logoColor=black)](https://expressjs.com/)
  [![Queue](https://img.shields.io/badge/Queue-BullMQ_%26_Redis-e22020?style=for-the-badge&logo=redis&logoColor=white)](https://bullmq.io/)
  [![Database](https://img.shields.io/badge/Database-PostgreSQL_%26_Prisma-336791?style=for-the-badge&logo=postgresql&logoColor=white)](https://prisma.io)
  [![AI](https://img.shields.io/badge/Core_AI-Claude_3.5_Sonnet-8a3ffc?style=for-the-badge&logo=anthropic&logoColor=white)](https://anthropic.com)
</div>

---

## 🛰️ System Architecture

NextRole operates as a distributed system, linking a chrome-injected content script side panel with a high-throughput Express.js backend, a BullMQ queue processor, and Claude AI for resume compiling:

```mermaid
graph TD
    subgraph WXT Browser Extension MV3
        Popup[System Console Popup] <--> CS[In-Page Content Script HUD]
        CS <--> BG[Background Service Worker]
    end

    subgraph Cyber API Backend
        BG <--> API[Express API Server]
        API <--> DB[(Prisma PostgreSQL)]
        API <--> Redis[(Redis Message Broker)]
    end

    subgraph Processing Nodes
        Redis <--> Worker[BullMQ Queue Worker]
        Worker <--> Scrape[Playwright Careers Scraper]
        Worker <--> Claude[Claude AI Resume Tailor]
    end

    classDef cyan fill:#0a1628,stroke:#00f0ff,stroke-width:2px,color:#e2eaf4;
    classDef yellow fill:#0d1c2d,stroke:#f0ff00,stroke-width:2px,color:#e2eaf4;
    classDef green fill:#022d15,stroke:#00c851,stroke-width:1px,color:#e2eaf4;
    
    class Popup,CS,BG yellow;
    class API,DB,Redis cyan;
    class Worker,Scrape,Claude green;
```

---

## ⚡ Core Features

### 🤖 1. Real-Time Tailored Resume HUD
* **ATS Content Scraper:** Detects supported ATS career platforms (Lever, Greenhouse, MyWorkdayJobs, and LinkedIn) and dynamically harvests job postings.
* **Claude-Tailored Resumes:** Feeds active job descriptions alongside your saved candidate profile to Claude AI, compiling a custom resume tailored to match matching keyword densities.
* **Inline Preview & Download:** Renders a gorgeous card directly inside the browser showing an inline preview of the tailored text, with an instant one-click option to download a completed A4 PDF.

### 🎛️ 2. Targeted Monitoring Console
* **Segmented Keyword Filters:** Choose between tracking all jobs or filtering for exact keywords.
* **Interactive Tag Console:** Add or remove role and stack tags dynamically (e.g. `Software Engineer`, `TypeScript`, `Node.js`).
* **Location Targeting:** Automatically filters career openings using a built-in location matrix.
* **Instant Latency Alerts:** Syncs real-time connection status between your browser and local PostgreSQL nodes.

### 📡 3. Saved Channel Feed
* **Tracking Synchronizer:** Instantly bookmark career boards on LinkedIn or job boards in one click.
* **Autoclean HMR System:** Integrated side panel memory sweepers instantly purge old nodes on WXT hot-reloads to prevent memory leaks.

---

## 📂 Project Structure

```text
├── entrypoints/
│   ├── background.ts      # Browser background worker (polling scheduler & alerts)
│   ├── content.ts         # Embedded in-page co-pilot side panel (Glassmorphism UI)
│   └── popup/
│       ├── index.html     # Redesigned Midnight Navy & Neon Yellow Popup Console
│       └── popup.ts       # Tags engine, segmented state, and latency metrics
├── jobtracker-backend/
│   ├── server.ts          # Express API Server (Prisma routing, Checkout gate)
│   ├── worker.ts          # BullMQ queue runner (Playwright scrapers & Claude)
│   ├── scraper.ts         # ATS scraping engines (Lever, Greenhouse, Workday)
│   └── prisma/
│       └── schema.prisma  # PostgreSQL schema definitions
├── package.json
└── wxt.config.ts          # WXT Manifest & Extension packager
```

---

## 🚀 Setup & Installation

### 1. Backend Server Setup
Navigate into the backend directory and configure your credentials:

```bash
cd jobtracker-backend
npm install
```

Create a `.env` file in `jobtracker-backend/`:
```env
PORT=5000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/jobtracker?schema=public"
REDIS_URL="redis://127.0.0.1:6379"
ANTHROPIC_API_KEY="sk-ant-yourkey"
STRIPE_SECRET_KEY="sk_test_yourkey"
```

Sync database tables and generate the Prisma Client:
```bash
npx prisma db push
npx prisma generate
```

### 2. Extension Setup
Install dependencies in the root directory:

```bash
cd ..
npm install
```

---

## 💻 Running the Platform

To run the full end-to-end stack, launch three terminal environments:

### Terminal 1: WXT Dev Server
Launches WXT in dev mode, which automatically opens a custom Chrome developer window with NextRole loaded:
```bash
npm run dev
```

### Terminal 2: Express Server
Launches the backend router:
```bash
cd jobtracker-backend
npx tsx watch server.ts
```

### Terminal 3: BullMQ Scraper Worker
Starts the background queue listener:
```bash
cd jobtracker-backend
npx tsx watch worker.ts
```

---

## 🛠️ Technology Stack
* **WXT (Web Extension Framework):** Next-gen extension compiler for Manifest V3.
* **Express & TypeScript:** Blazing fast backend operations.
* **Prisma ORM & PostgreSQL:** Robust storage for master resumes and tracked searches.
* **Redis & BullMQ:** Fault-tolerant distributed queue runner.
* **Playwright Scraper:** Headless browser automation.
* **Claude AI (Anthropic):** Intelligent, semantic resume optimization.
