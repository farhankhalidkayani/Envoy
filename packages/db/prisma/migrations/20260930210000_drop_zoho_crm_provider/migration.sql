-- AlterEnum
BEGIN;
CREATE TYPE "CrmProvider_new" AS ENUM ('hubspot');
ALTER TABLE "crm_connections" ALTER COLUMN "provider" TYPE "CrmProvider_new" USING ("provider"::text::"CrmProvider_new");
ALTER TYPE "CrmProvider" RENAME TO "CrmProvider_old";
ALTER TYPE "CrmProvider_new" RENAME TO "CrmProvider";
DROP TYPE "public"."CrmProvider_old";
COMMIT;
