export type CreditUpdateMany = (args: {
  where: { id: string; credits: { gt: number } };
  data: { credits: { decrement: number } };
}) => PromiseLike<{ count: number }>;

export async function reserveCredit(
  userId: string,
  updateMany: CreditUpdateMany,
): Promise<boolean> {
  const result = await updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });

  return result.count === 1;
}

export class OutOfCreditsError extends Error {
  constructor() {
    super("User is out of credits");
    this.name = "OutOfCreditsError";
  }
}

export class CreditReservationError extends Error {
  constructor(cause: unknown) {
    super("The available credit could not be checked", { cause });
    this.name = "CreditReservationError";
  }
}

export class CreditRefundError extends Error {
  readonly operationError: unknown;
  readonly refundError: unknown;

  constructor(operationError: unknown, refundError: unknown) {
    super("The operation failed and its reserved credit could not be refunded", {
      cause: refundError,
    });
    this.name = "CreditRefundError";
    this.operationError = operationError;
    this.refundError = refundError;
  }
}

type ExecuteWithReservedCreditOptions<Result> = {
  reserve: () => Promise<boolean>;
  generate: () => Promise<Result>;
  persist: (result: Result) => Promise<unknown>;
  refund: () => Promise<unknown>;
};

export async function executeWithReservedCredit<Result>({
  reserve,
  generate,
  persist,
  refund,
}: ExecuteWithReservedCreditOptions<Result>): Promise<Result> {
  let reserved: boolean;
  try {
    reserved = await reserve();
  } catch (error) {
    throw new CreditReservationError(error);
  }

  if (!reserved) {
    throw new OutOfCreditsError();
  }

  try {
    const result = await generate();
    await persist(result);
    return result;
  } catch (operationError) {
    try {
      await refund();
    } catch (refundError) {
      throw new CreditRefundError(operationError, refundError);
    }
    throw operationError;
  }
}
