-- CreateExtension
-- CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "TrackedSearch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastScrapedAt" TIMESTAMP(3),
    "lastScrapeStatus" TEXT,
    "lastScrapeError" TEXT,
    "newJobCount" INTEGER NOT NULL DEFAULT 0,
    "boardSlug" TEXT,
    "atsType" TEXT,

    CONSTRAINT "TrackedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSnapshot" (
    "id" TEXT NOT NULL,
    "trackedSearchId" TEXT NOT NULL,
    "atsJobId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "companyName" TEXT,
    "matchReason" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isNew" BOOLEAN NOT NULL DEFAULT true,
    "seenAt" TIMESTAMP(3),
    "jobEmbedding" text,
    "embeddingStatus" TEXT DEFAULT 'pending',
    "embeddingRetries" INTEGER NOT NULL DEFAULT 0,
    "semanticScore" DOUBLE PRECISION,

    CONSTRAINT "JobSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "linkedinUrl" TEXT,
    "targetRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "watchlistCompanies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "experienceLevel" TEXT,
    "alertMode" TEXT NOT NULL DEFAULT 'instant',
    "emailAlerts" BOOLEAN NOT NULL DEFAULT false,
    "isOnboarded" BOOLEAN NOT NULL DEFAULT false,
    "monitorActive" BOOLEAN NOT NULL DEFAULT false,
    "experience" TEXT NOT NULL DEFAULT '',
    "skills" TEXT NOT NULL DEFAULT '',
    "education" TEXT NOT NULL DEFAULT '',
    "projects" TEXT NOT NULL DEFAULT '',
    "profileEmbedding" text,
    "embeddingStatus" TEXT DEFAULT 'pending',
    "embeddingRetries" INTEGER NOT NULL DEFAULT 0,
    "passwordHash" TEXT,
    "isPremium" BOOLEAN NOT NULL DEFAULT false,
    "monthlyRunsUsed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TailoredResume" (
    "id" TEXT NOT NULL,
    "jobSnapshotId" TEXT NOT NULL,
    "resumeText" TEXT NOT NULL,
    "pdfUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TailoredResume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedSearch_userId_idx" ON "TrackedSearch"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedSearch_userId_url_key" ON "TrackedSearch"("userId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "JobSnapshot_trackedSearchId_atsJobId_key" ON "JobSnapshot"("trackedSearchId", "atsJobId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_userId_key" ON "UserSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_stripeCustomerId_key" ON "UserSubscription"("stripeCustomerId");

-- AddForeignKey
ALTER TABLE "JobSnapshot" ADD CONSTRAINT "JobSnapshot_trackedSearchId_fkey" FOREIGN KEY ("trackedSearchId") REFERENCES "TrackedSearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TailoredResume" ADD CONSTRAINT "TailoredResume_jobSnapshotId_fkey" FOREIGN KEY ("jobSnapshotId") REFERENCES "JobSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
