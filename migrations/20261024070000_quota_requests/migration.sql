-- Fail rather than silently altering historical balances.
ALTER TABLE "User" ADD CONSTRAINT "User_credits_nonnegative" CHECK ("credits" >= 0);

CREATE TYPE "GenerationStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');
CREATE TABLE "GenerationRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "GenerationStatus" NOT NULL DEFAULT 'PROCESSING',
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GenerationRequest_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "PlanResult" ADD COLUMN "generationRequestId" TEXT;
CREATE UNIQUE INDEX "PlanResult_generationRequestId_key" ON "PlanResult"("generationRequestId");
CREATE INDEX "GenerationRequest_userId_status_idx" ON "GenerationRequest"("userId", "status");
ALTER TABLE "GenerationRequest" ADD CONSTRAINT "GenerationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlanResult" ADD CONSTRAINT "PlanResult_generationRequestId_fkey" FOREIGN KEY ("generationRequestId") REFERENCES "GenerationRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
