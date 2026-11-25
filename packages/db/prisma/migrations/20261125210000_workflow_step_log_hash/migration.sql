-- AlterTable
ALTER TABLE "workflow_step_logs" ADD COLUMN     "toHash" TEXT;

-- CreateIndex
CREATE INDEX "workflow_step_logs_toHash_idx" ON "workflow_step_logs"("toHash");

