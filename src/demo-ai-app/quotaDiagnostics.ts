type Phase = "preflight" | "reservation" | "provider" | "save" | "recovery" | "action" | "quota-query";
type Context = { requestId?: string; userId?: string; code?: string };
const errorNames = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError",
  "PrismaClientKnownRequestError", "PrismaClientUnknownRequestError",
  "PrismaClientInitializationError", "PrismaClientValidationError", "PrismaClientRustPanicError",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** Only allow diagnostic identifiers; never serialize messages, stacks, meta or causes. */
export function safeErrorFields(error: unknown) {
  try {
    const source = record(error);
    const nested = record(source?.cause);
    const candidates = [source, record(source?.meta), nested, record(nested?.meta)];
    const fields: { errorName: string; prismaCode?: string; sqlState?: string } = {
      errorName: typeof source?.name === "string" && errorNames.has(source.name) ? source.name : "UnknownError",
    };
    for (const candidate of candidates) {
      for (const key of ["code", "errorCode", "sqlState", "sqlstate"]) {
        const value = candidate?.[key];
        if (typeof value !== "string") continue;
        if (/^P\d{4}$/.test(value)) fields.prismaCode ??= value;
        else if (/^[0-9A-Z]{5}$/.test(value)) fields.sqlState ??= value;
      }
    }
    return fields;
  } catch {
    // An unusual error object must not break settlement or leak its contents.
    return { errorName: "UnknownError" };
  }
}

export function logQuotaFailure(phase: Phase, error: unknown, context: Context = {}) {
  console.error(JSON.stringify({ event: "generation.error", phase, ...context, ...safeErrorFields(error) }));
}
