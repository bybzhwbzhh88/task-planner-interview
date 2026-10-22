BEGIN;

-- Refuse to invent a balance for historical overdrafts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE credits < 0) THEN
    RAISE EXCEPTION 'Negative historical credits found; inspect before migrating';
  END IF;
END $$;

ALTER TABLE "User" ADD CONSTRAINT "User_credits_nonnegative" CHECK ("credits" >= 0);
CREATE TYPE "GenerationStatus" AS ENUM ('RESERVED', 'SUCCEEDED', 'RELEASED');
CREATE TABLE "GenerationAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "GenerationStatus" NOT NULL DEFAULT 'RESERVED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GenerationAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GenerationAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "GenerationAttempt_userId_status_idx" ON "GenerationAttempt"("userId", "status");
ALTER TABLE "PlanResult" ADD COLUMN "generationAttemptId" TEXT;
CREATE UNIQUE INDEX "PlanResult_generationAttemptId_key" ON "PlanResult"("generationAttemptId");
ALTER TABLE "PlanResult" ADD CONSTRAINT "PlanResult_generationAttemptId_fkey"
  FOREIGN KEY ("generationAttemptId") REFERENCES "GenerationAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
