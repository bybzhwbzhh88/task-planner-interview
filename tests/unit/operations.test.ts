import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePlan, getCredits } from "../../src/demo-ai-app/operations";
import { generatePlanWithCredits, PlanGenerationError } from "../../src/demo-ai-app/generatePlanWithCredits";
import { generateMockSchedule } from "../../src/demo-ai-app/mockAi";
import { prisma } from "../helpers/waspServer";

vi.mock("../../src/demo-ai-app/generatePlanWithCredits", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/demo-ai-app/generatePlanWithCredits")>(),
  generatePlanWithCredits: vi.fn(),
}));

const run = vi.mocked(generatePlanWithCredits);
const context = (user: { id: string; credits: number } | undefined) => ({
  user, entities: { User: prisma.user },
}) as unknown as Parameters<typeof generatePlan>[1];

beforeEach(() => {
  run.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("authenticated operation boundary (A8)", () => {
  it("rejects unauthenticated generation before any work", async () => {
    await expect(generatePlan({ hours: 8 }, context(undefined))).rejects.toMatchObject({ statusCode: 401 });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([0, -1, 25, NaN, Infinity, -Infinity, "8", null, undefined])("rejects invalid hours %s", async (hours) => {
    await expect(generatePlan({ hours } as never, context({ id: "alice", credits: 3 })))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([1, 1.5, 24])("passes the authenticated id and valid hours %s, ignoring cached credits", async (hours) => {
    run.mockResolvedValue({ tasks: [], taskItems: [] });
    await generatePlan({ hours }, context({ id: "alice", credits: 0 }));
    expect(run).toHaveBeenCalledTimes(1);
    const [db, id, receivedHours, provider] = run.mock.calls[0];
    // Compare the Prisma proxy by identity; deep comparison recurses into it.
    expect(db === prisma).toBe(true);
    expect(id).toBe("alice");
    expect(receivedHours).toBe(hours);
    expect(provider === generateMockSchedule).toBe(true);
  });

  it.each([
    ["no-credits", 402], ["no-tasks", 400], ["provider-failed", 502],
  ] as const)("maps %s to %s", async (reason, statusCode) => {
    run.mockRejectedValue(new PlanGenerationError(reason));
    await expect(generatePlan({ hours: 8 }, context({ id: "alice", credits: 99 })))
      .rejects.toMatchObject({ statusCode });
  });

  it("does not label an unknown database error as a confirmed free failure", async () => {
    const error = new Error("Connection lost during commit");
    run.mockRejectedValue(error);
    await expect(generatePlan({ hours: 8 }, context({ id: "alice", credits: 1 }))).rejects.toBe(error);
  });

  it("requires login for the balance query", async () => {
    const find = vi.spyOn(prisma.user, "findUnique");
    await expect(getCredits(undefined, context(undefined))).rejects.toMatchObject({ statusCode: 401 });
    expect(find).not.toHaveBeenCalled();
  });

  it("queries only the authenticated user's current balance", async () => {
    const find = vi.spyOn(prisma.user, "findUnique").mockResolvedValue({ credits: 2 } as never);
    expect(await getCredits(undefined, context({ id: "alice", credits: 99 }))).toBe(2);
    expect(find).toHaveBeenCalledExactlyOnceWith({ where: { id: "alice" }, select: { credits: true } });
  });
});
