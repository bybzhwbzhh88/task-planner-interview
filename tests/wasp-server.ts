// Only Wasp's module assembly is replaced; all data operations use PostgreSQL.
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  datasources: { db: { url: process.env.TEST_DATABASE_URL } },
});

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message = `HTTP ${statusCode}`,
    public data?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
