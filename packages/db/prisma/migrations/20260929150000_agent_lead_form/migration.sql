-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "leadFormId" TEXT;

-- CreateIndex
CREATE INDEX "agents_leadFormId_idx" ON "agents"("leadFormId");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_leadFormId_fkey" FOREIGN KEY ("leadFormId") REFERENCES "forms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

