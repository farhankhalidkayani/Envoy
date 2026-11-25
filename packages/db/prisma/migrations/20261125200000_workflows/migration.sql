-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('draft', 'live', 'paused');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('running', 'completed', 'stopped', 'failed');

-- CreateEnum
CREATE TYPE "StepLogStatus" AS ENUM ('sent', 'skipped', 'failed', 'waiting');

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'draft',
    "trigger" JSONB NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "steps" JSONB NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'running',
    "stopReason" TEXT,
    "nextStep" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_step_logs" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" "StepLogStatus" NOT NULL,
    "detail" TEXT,
    "channel" TEXT,
    "toMasked" TEXT,
    "providerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_step_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opt_outs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opt_outs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflows_tenantId_status_idx" ON "workflows"("tenantId", "status");

-- CreateIndex
CREATE INDEX "workflow_runs_tenantId_createdAt_idx" ON "workflow_runs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "workflow_runs_sourceType_sourceId_idx" ON "workflow_runs"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_workflowId_sourceType_sourceId_key" ON "workflow_runs"("workflowId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "workflow_step_logs_tenantId_createdAt_idx" ON "workflow_step_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_step_logs_runId_stepIndex_key" ON "workflow_step_logs"("runId", "stepIndex");

-- CreateIndex
CREATE UNIQUE INDEX "opt_outs_tenantId_channel_address_key" ON "opt_outs"("tenantId", "channel", "address");

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step_logs" ADD CONSTRAINT "workflow_step_logs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opt_outs" ADD CONSTRAINT "opt_outs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

