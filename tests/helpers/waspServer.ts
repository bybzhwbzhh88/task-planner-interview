// Tests invoke operation functions directly. This replaces only Wasp's runtime
// exports, not Prisma or its SQL/transactions. HTTP middleware is not covered.
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.TEST_DATABASE_URL ?? "postgresql://unused:unused@127.0.0.1:1/quota_test" },
  },
});

export class HttpError extends Error {
  constructor(readonly statusCode: number, message?: string, readonly data?: unknown) {
    super(message);
  }
}
