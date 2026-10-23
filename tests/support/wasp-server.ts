import { PrismaClient } from "@prisma/client";
export { HttpError } from "../../.wasp/out/sdk/wasp/server/HttpError";

// Only replace the Wasp module wiring; all database delegates and transactions are real.
export const prisma = new PrismaClient();
