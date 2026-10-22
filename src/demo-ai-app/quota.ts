/** One reservation is held for exactly one generation attempt. */
export interface QuotaStore {
  reserveCredit(userId: string): Promise<boolean>;
  refundCredit(userId: string): Promise<void>;
}

export class NoCreditError extends Error {
  constructor() {
    super("No available credits");
    this.name = "NoCreditError";
  }
}

export class ReservationStateUnknownError extends Error {
  constructor(cause: unknown) {
    super("Could not confirm credit reservation", { cause });
    this.name = "ReservationStateUnknownError";
  }
}

export class RefundFailedError extends Error {
  readonly workError: unknown;
  readonly refundError: unknown;

  constructor(
    workError: unknown,
    refundError: unknown,
  ) {
    super("Could not confirm credit refund", { cause: refundError });
    this.name = "RefundFailedError";
    this.workError = workError;
    this.refundError = refundError;
  }
}

export async function runWithReservedCredit<Result>(
  store: QuotaStore,
  userId: string,
  work: () => Promise<Result>,
): Promise<Result> {
  let reserved: boolean;
  try {
    reserved = await store.reserveCredit(userId);
  } catch (error) {
    throw new ReservationStateUnknownError(error);
  }
  if (!reserved) {
    throw new NoCreditError();
  }

  try {
    return await work();
  } catch (workError) {
    try {
      await store.refundCredit(userId);
    } catch (refundError) {
      throw new RefundFailedError(workError, refundError);
    }
    throw workError;
  }
}
