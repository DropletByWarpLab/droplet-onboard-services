-- CreateEnum
CREATE TYPE "RemoteToolDefinitionStatus" AS ENUM ('CURRENT', 'CHANGED');

-- AlterTable
ALTER TABLE "RemoteToolClassification" ADD COLUMN     "definitionStatus" "RemoteToolDefinitionStatus" NOT NULL DEFAULT 'CURRENT',
ADD COLUMN     "definitionChangedAt" TIMESTAMP(3),
ADD COLUMN     "previousReviewHash" TEXT,
ADD COLUMN     "previousWireDescription" TEXT;
