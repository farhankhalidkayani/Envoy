-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "crmExternalId" TEXT,
ADD COLUMN     "crmPushError" TEXT,
ADD COLUMN     "crmPushedAt" TIMESTAMP(3);
