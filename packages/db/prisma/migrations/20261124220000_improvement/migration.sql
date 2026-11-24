-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('open', 'dismissed');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('pending', 'tested', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "turnCount" INTEGER;

-- CreateTable
CREATE TABLE "insights" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "InsightStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "insightId" TEXT,
    "baseVersion" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'pending',
    "testResult" JSONB,
    "appliedVersion" INTEGER,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insights_tenantId_idx" ON "insights"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "insights_agentId_agentVersion_fingerprint_key" ON "insights"("agentId", "agentVersion", "fingerprint");

-- CreateIndex
CREATE INDEX "proposals_agentId_createdAt_idx" ON "proposals"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "proposals_tenantId_idx" ON "proposals"("tenantId");

-- AddForeignKey
ALTER TABLE "insights" ADD CONSTRAINT "insights_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights" ADD CONSTRAINT "insights_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "insights"("id") ON DELETE SET NULL ON UPDATE CASCADE;

