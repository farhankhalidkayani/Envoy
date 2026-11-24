-- CreateEnum
CREATE TYPE "ModelProviderKind" AS ENUM ('anthropic', 'openai', 'gemini', 'groq', 'openai_compatible');

-- CreateEnum
CREATE TYPE "ModelCredentialStatus" AS ENUM ('active', 'invalid');

-- CreateEnum
CREATE TYPE "ModelKeySource" AS ENUM ('tenant', 'platform');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "modelConfig" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "model_credentials" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "ModelProviderKind" NOT NULL,
    "label" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "baseUrl" TEXT,
    "status" "ModelCredentialStatus" NOT NULL DEFAULT 'active',
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_usage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "credentialId" TEXT,
    "role" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "keySource" "ModelKeySource" NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_credentials_tenantId_idx" ON "model_credentials"("tenantId");

-- CreateIndex
CREATE INDEX "model_usage_tenantId_createdAt_idx" ON "model_usage"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "model_credentials" ADD CONSTRAINT "model_credentials_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

