-- CreateEnum
CREATE TYPE "RunStepKind" AS ENUM ('model', 'tool', 'judge', 'extract', 'limit');

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "spec" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "agentVersion" INTEGER,
ADD COLUMN     "goalProgress" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "handoffReason" TEXT;

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_steps" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "RunStepKind" NOT NULL,
    "name" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_versions_tenantId_idx" ON "agent_versions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agentId_version_key" ON "agent_versions"("agentId", "version");

-- CreateIndex
CREATE INDEX "agent_run_steps_tenantId_idx" ON "agent_run_steps"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_steps_conversationId_seq_key" ON "agent_run_steps"("conversationId", "seq");

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

