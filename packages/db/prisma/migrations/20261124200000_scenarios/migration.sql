-- CreateTable
CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "turns" JSONB NOT NULL,
    "expect" JSONB NOT NULL DEFAULT '{}',
    "sandbox" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "scenarioId" TEXT,
    "agentVersion" INTEGER NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'current',
    "passed" BOOLEAN NOT NULL,
    "error" TEXT,
    "result" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scenarios_agentId_idx" ON "scenarios"("agentId");

-- CreateIndex
CREATE INDEX "scenarios_tenantId_idx" ON "scenarios"("tenantId");

-- CreateIndex
CREATE INDEX "scenario_runs_agentId_createdAt_idx" ON "scenario_runs"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "scenario_runs_tenantId_createdAt_idx" ON "scenario_runs"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

