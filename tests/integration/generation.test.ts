import { expect, it, vi } from "vitest";
import { generateForUser, SaveRejectedError } from "../../src/demo-ai-app/planGeneration";
import { account, admin, connection, deps, state } from "./support";
import type { GenerationLogEvent } from "../../src/demo-ai-app/generation";

it("P3 真实Prisma外键拒绝经适配器包装后保留安全错误码并返还", async () => {
  const privateTask = "P3-private-task-description";
  const user = await account(1, privateTask); const d = deps(await connection());
  const logs: GenerationLogEvent[] = []; d.log = entry => { logs.push(entry); };
  const save = d.store.save;
  // Inject only the invalid foreign key; the actual Prisma write and error wrapper remain real.
  d.store.save = (_user, requestId, schedule) => save("missing-user-for-p3", requestId, schedule);
  expect(await generateForUser(user, { hours: 8 }, d)).toMatchObject({ code: "SAVE_FAILED_REFUNDED" });
  expect(logs.find(entry => entry.event === "plan-generation.save-error")).toEqual({
    event: "plan-generation.save-error", requestId: expect.any(String), userId: user,
    stage: "save", errorKind: "prisma-known", prismaCode: "P2003",
  });
  expect(JSON.stringify(logs)).not.toContain(privateTask);
  expect(JSON.stringify(logs)).not.toContain("missing-user-for-p3");
  expect(await state(user)).toEqual({ credits: 1, results: 0 });
});

it("A01 真实数据库成功保存并消费一个额度", async () => {
  const user = await account(3); const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    expect(await generateForUser(user, { hours: 8 }, deps(await connection()))).toMatchObject({ status: "succeeded", availableCredits: 2 });
    expect(await state(user)).toEqual({ credits: 2, results: 1 });
    expect(log.mock.calls.filter(([line]) => JSON.parse(line).event === "mock-ai.started")).toHaveLength(1);
  } finally { log.mockRestore(); }
});
it("A02 无额度不会产生 mock-ai.started", async () => {
  const user = await account(0); const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await expect(generateForUser(user, { hours: 8 }, deps(await connection()))).rejects.toMatchObject({ code: "NO_CREDITS" });
    expect(log.mock.calls).toHaveLength(0);
    expect(await state(user)).toEqual({ credits: 0, results: 0 });
  } finally { log.mockRestore(); }
});
it("A03 模型明确失败返还真实数据库额度", async () => {
  const user = await account(1, "[fail]");
  expect(await generateForUser(user, { hours: 8 }, deps(await connection()))).toMatchObject({ code: "MODEL_FAILED_REFUNDED" });
  expect(await state(user)).toEqual({ credits: 1, results: 0 });
});
it("A08 Prisma 唯一约束拒绝被分类为明确未提交", async () => {
  const user = await account(1); const d = deps(await connection());
  const schedule = { tasks: [], taskItems: [] };
  await d.store.save(user, "duplicate-case", schedule);
  await expect(d.store.save(user, "duplicate-case", schedule)).rejects.toBeInstanceOf(SaveRejectedError);
});
it("Prisma 外键拒绝被分类为明确未提交", async () => {
  const d = deps(await connection());
  await expect(d.store.save("missing-user", "missing-foreign-key", { tasks: [], taskItems: [] })).rejects.toBeInstanceOf(SaveRejectedError);
});
it("A08 明确保存拒绝后原子返还一次", async () => {
  const user = await account(1); const d = deps(await connection());
  d.store.save = async () => { throw new SaveRejectedError(); };
  expect(await generateForUser(user, { hours: 8 }, d)).toMatchObject({ code: "SAVE_FAILED_REFUNDED" });
  expect(await state(user)).toEqual({ credits: 1, results: 0 });
});
it("A09 已保存后响应丢失可从真实数据库核对", async () => {
  const user = await account(1); const d = deps(await connection()); const save = d.store.save;
  d.store.save = async (...args) => { await save(...args); throw new Error("simulated lost response"); };
  expect(await generateForUser(user, { hours: 8 }, d)).toMatchObject({ status: "succeeded", availableCredits: 0 });
  expect(await state(user)).toEqual({ credits: 0, results: 1 });
});
it("A10 保存结果未知且核对为空时不盲目返还", async () => {
  const user = await account(1); const d = deps(await connection());
  d.store.save = async () => { throw new Error("unknown commit"); };
  expect(await generateForUser(user, { hours: 8 }, d)).toMatchObject({ code: "SETTLEMENT_UNKNOWN" });
  expect(await state(user)).toEqual({ credits: 0, results: 0 });
});
it("A11 预占已提交但响应丢失不发起模型调用", async () => {
  const user = await account(1); const d = deps(await connection()); const reserve = d.store.reserve;
  d.store.reserve = async id => { await reserve(id); throw new Error("unknown reservation"); };
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    expect(await generateForUser(user, { hours: 8 }, d)).toMatchObject({ code: "SETTLEMENT_UNKNOWN" });
    expect(log.mock.calls).toHaveLength(0);
    expect(await state(user)).toEqual({ credits: 0, results: 0 });
  } finally { log.mockRestore(); }
});
it.each([false, true])("A12 真实返还提交后报错=%s 不重复返还", async committed => {
  const user = await account(1, "[fail]"); const d = deps(await connection()); const refund = d.store.refund; let attempts = 0;
  d.store.refund = async id => { attempts++; if (committed) await refund(id); throw new Error("unknown refund"); };
  expect(await generateForUser(user, { hours: 8 }, d)).toMatchObject({ code: "SETTLEMENT_UNKNOWN" });
  expect(attempts).toBe(1);
  expect(await state(user)).toEqual({ credits: committed ? 1 : 0, results: 0 });
});
it("A13 余额查询失败仍返回已确认保存的成功结果", async () => {
  const user = await account(1); const d = deps(await connection());
  d.store.credits = async () => { throw new Error("offline read"); };
  expect(await generateForUser(user, { hours: 8 }, d)).toMatchObject({ status: "succeeded", availableCredits: null });
  expect(await state(user)).toEqual({ credits: 0, results: 1 });
});
it("A16 任务及指定结果均按账号隔离", async () => {
  const own = await account(1, "自己任务"); const other = await account(1, "其他任务"); const d = deps(await connection());
  expect(await d.store.listTasks(own)).toEqual([{ description: "自己任务", time: "1" }]);
  const result = await generateForUser(other, { hours: 8 }, d);
  if (result.status !== "succeeded") throw new Error("expected success");
  expect(await d.store.find(own, result.plan.id)).toBeNull();
  expect(await admin.planResult.count({ where: { userId: own } })).toBe(0);
});
