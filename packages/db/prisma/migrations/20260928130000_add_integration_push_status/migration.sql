-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "integrationStatus" JSONB NOT NULL DEFAULT '{}';
