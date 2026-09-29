-- CreateEnum
CREATE TYPE "SessionScope" AS ENUM ('portal', 'admin');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "appScope" "SessionScope" NOT NULL DEFAULT 'portal';

