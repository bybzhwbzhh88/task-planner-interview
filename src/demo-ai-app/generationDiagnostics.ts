import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import type { SafeGenerationError } from "./generation";

/** Server-only: emit fixed categories and bounded codes, never serialize an error. */
export function classifyGenerationError(error: unknown): SafeGenerationError {
  const withCode = (errorKind: "prisma-known" | "prisma-initialization", value: unknown): SafeGenerationError => {
    const prismaCode = typeof value === "string" && value.length === 5 && /^P[0-9]{4}$/.test(value) ? value : undefined;
    return prismaCode ? { errorKind, prismaCode } : { errorKind };
  };
  try {
    if (error instanceof Prisma.PrismaClientKnownRequestError) return withCode("prisma-known", error.code);
    if (error instanceof Prisma.PrismaClientInitializationError) return withCode("prisma-initialization", error.errorCode);
    if (error instanceof Prisma.PrismaClientValidationError) return { errorKind: "prisma-validation" };
    if (error instanceof Prisma.PrismaClientUnknownRequestError) return { errorKind: "prisma-unknown" };
    if (error instanceof Prisma.PrismaClientRustPanicError) return { errorKind: "prisma-panic" };
    if (error instanceof ZodError) return { errorKind: "result-validation" };
    if (error instanceof SyntaxError) return { errorKind: "result-parse" };
  } catch { /* Uninspectable thrown values still must not affect settlement. */ }
  return { errorKind: "transport-or-unknown" };
}
