import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import * as z from "zod";
import { generateForUser, GenerationError, SaveRejectedError } from "../../src/demo-ai-app/planGeneration";
import type { GenerationDeps, GenerationLogEvent, PlanStore, StoredPlan } from "../../src/demo-ai-app/generation";

const schedule = { tasks: [{ name: "学习", priority: "medium" as const }], taskItems: [{ description: "执行", taskName: "学习", time: 1 }] };

function fixture(initial = 1) {
  let balance = initial;
  const plans = new Map<string, StoredPlan>();
  const events: string[] = [];
  const logs: GenerationLogEvent[] = [];
  const store: PlanStore = {
    async listTasks() { events.push("tasks"); return [{ description: "学习", time: "1" }]; },
    async reserve() { events.push("reserve"); if (balance <= 0) return false; balance--; return true; },
    async save(_user, id, value) { events.push("save"); const plan = { id, createdAt: new Date("2026-10-23T00:00:00Z"), schedule: value }; plans.set(id, plan); return plan; },
    async find(_user, id) { events.push("find"); return plans.get(id) ?? null; },
    async refund() { events.push("refund"); balance++; },
    async credits() { events.push("credits"); return balance; },
  };
  const deps: GenerationDeps = { store, async generate() { events.push("generate"); return schedule; }, newId: () => "request-1", log: event => { logs.push(event); } };
  return { store, deps, events, logs, plans, balance: () => balance };
}

const sensitive = "PRIVATE_TASK_password_connection_string";
const knownError = (code: string) => new Prisma.PrismaClientKnownRequestError(sensitive, { code, clientVersion: "5.19.1", meta: { privateValue: sensitive } });

describe("异常日志的安全分类", () => {
  it.each([
    { name: "唯一约束拒绝的包装cause", error: new SaveRejectedError(sensitive, { cause: knownError("P2002") }), fields: { errorKind: "prisma-known", prismaCode: "P2002" }, outcome: "SAVE_FAILED_REFUNDED" },
    { name: "外键拒绝的包装cause", error: new SaveRejectedError(sensitive, { cause: knownError("P2003") }), fields: { errorKind: "prisma-known", prismaCode: "P2003" }, outcome: "SAVE_FAILED_REFUNDED" },
    { name: "参数校验拒绝的包装cause", error: new SaveRejectedError(sensitive, { cause: new Prisma.PrismaClientValidationError(sensitive, { clientVersion: "5.19.1" }) }), fields: { errorKind: "prisma-validation" }, outcome: "SAVE_FAILED_REFUNDED" },
    { name: "无cause的明确拒绝", error: new SaveRejectedError(sensitive), fields: { errorKind: "save-rejected" }, outcome: "SAVE_FAILED_REFUNDED" },
    { name: "未知cause的明确拒绝", error: new SaveRejectedError(sensitive, { cause: { privateValue: sensitive } }), fields: { errorKind: "save-rejected" }, outcome: "SAVE_FAILED_REFUNDED" },
    { name: "连接初始化失败", error: new Prisma.PrismaClientInitializationError(sensitive, "5.19.1", "P1001"), fields: { errorKind: "prisma-initialization", prismaCode: "P1001" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "连接池超时", error: knownError("P2024"), fields: { errorKind: "prisma-known", prismaCode: "P2024" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "未经适配器确认的拒绝不因诊断而返还", error: knownError("P2002"), fields: { errorKind: "prisma-known", prismaCode: "P2002" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "未知Prisma请求错误", error: new Prisma.PrismaClientUnknownRequestError(sensitive, { clientVersion: "5.19.1" }), fields: { errorKind: "prisma-unknown" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "Prisma引擎异常", error: new Prisma.PrismaClientRustPanicError(sensitive, "5.19.1"), fields: { errorKind: "prisma-panic" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "结果结构校验", error: new z.ZodError([{ code: "custom", path: [sensitive], message: sensitive }]), fields: { errorKind: "result-validation" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "JSON解析失败", error: new SyntaxError(sensitive), fields: { errorKind: "result-parse" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "普通异常", error: new Error(sensitive, { cause: { privateValue: sensitive } }), fields: { errorKind: "transport-or-unknown" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "非Error抛出值", error: sensitive, fields: { errorKind: "transport-or-unknown" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "伪装Prisma的对象", error: { name: "PrismaClientKnownRequestError", code: "P2002", message: sensitive }, fields: { errorKind: "transport-or-unknown" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "异常错误码不能携带私密内容", error: knownError(`P2002\n${sensitive}`), fields: { errorKind: "prisma-known" }, outcome: "SETTLEMENT_UNKNOWN" },
    { name: "初始化错误码不能携带私密内容", error: new Prisma.PrismaClientInitializationError(sensitive, "5.19.1", sensitive), fields: { errorKind: "prisma-initialization" }, outcome: "SETTLEMENT_UNKNOWN" },
  ])("保存错误：$name", async ({ error, fields, outcome }) => {
    const f = fixture(); f.store.save = async () => { throw error; };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ status: "failed", code: outcome });
    expect(f.logs.find(entry => entry.event === "plan-generation.save-error")).toEqual({
      event: "plan-generation.save-error", requestId: "request-1", userId: "u1", stage: "save", ...fields,
    });
    expect(f.balance()).toBe(outcome === "SAVE_FAILED_REFUNDED" ? 1 : 0);
    expect(JSON.stringify(f.logs)).not.toContain(sensitive);
  });

  it("预占未知时携带阶段和安全类别，仍不调用模型", async () => {
    const f = fixture(); f.store.reserve = async () => { throw new Prisma.PrismaClientInitializationError(sensitive, "5.19.1", "P1001"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "SETTLEMENT_UNKNOWN" });
    expect(f.logs.at(-1)).toEqual({ event: "plan-generation.settlement-unknown", requestId: "request-1", userId: "u1", stage: "reserve", errorKind: "prisma-initialization", prismaCode: "P1001" });
    expect(f.events).not.toContain("generate");
  });
  it("核对解析失败和原保存错误分别记录，不相互覆盖", async () => {
    const f = fixture(); f.store.save = async () => { throw knownError("P2024"); };
    f.store.find = async () => { throw new SyntaxError(sensitive); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "SETTLEMENT_UNKNOWN" });
    expect(f.logs.find(entry => entry.event === "plan-generation.lookup-error")).toEqual({ event: "plan-generation.lookup-error", requestId: "request-1", userId: "u1", stage: "lookup", errorKind: "result-parse" });
    expect(f.logs.at(-1)).toMatchObject({ stage: "save", errorKind: "prisma-known", prismaCode: "P2024" });
    expect(f.events).not.toContain("refund");
    expect(JSON.stringify(f.logs)).not.toContain(sensitive);
  });
  it("返还失败标记refund阶段，保留一次返还语义", async () => {
    const f = fixture(); let refunds = 0;
    f.deps.generate = async () => { throw new Error(sensitive); };
    f.store.refund = async () => { refunds++; throw knownError("P1017"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "SETTLEMENT_UNKNOWN" });
    expect(f.logs.at(-1)).toMatchObject({ event: "plan-generation.settlement-unknown", stage: "refund", errorKind: "prisma-known", prismaCode: "P1017" });
    expect(refunds).toBe(1);
    expect(f.balance()).toBe(0);
    expect(JSON.stringify(f.logs)).not.toContain(sensitive);
  });
  it("成功后余额读取异常记录credits阶段而不改变成功结果", async () => {
    const f = fixture(); f.store.credits = async () => { throw new Error(sensitive); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ status: "succeeded", availableCredits: null });
    expect(f.logs.find(entry => entry.event === "plan-generation.credits-unavailable")).toMatchObject({ stage: "credits", errorKind: "transport-or-unknown" });
    expect(f.balance()).toBe(0);
    expect(JSON.stringify(f.logs)).not.toContain(sensitive);
  });
  it("无效模型输出记录结构校验类别，不泄漏输出内容", async () => {
    const f = fixture(); f.deps.generate = async () => ({ tasks: sensitive, taskItems: [] });
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "MODEL_FAILED_REFUNDED" });
    expect(f.logs.find(entry => entry.event === "plan-generation.model-error")).toMatchObject({ stage: "model", errorKind: "result-validation" });
    expect(f.balance()).toBe(1);
    expect(JSON.stringify(f.logs)).not.toContain(sensitive);
  });
  it("日志输出故障不会中断未知结算返回或增加返还", async () => {
    const f = fixture(); let refunds = 0;
    f.deps.log = () => { throw new Error("log unavailable"); };
    f.deps.generate = async () => { throw new Error(sensitive); };
    f.store.refund = async () => { refunds++; throw knownError("P1017"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "SETTLEMENT_UNKNOWN" });
    expect(refunds).toBe(1);
    expect(f.balance()).toBe(0);
  });
});

describe("生成额度编排", () => {
  it("预占已提交后抛错，不调用模型或盲目返还", async () => {
    const f = fixture(); const reserve = f.store.reserve;
    f.store.reserve = async id => { await reserve(id); throw new Error("lost acknowledgement"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "SETTLEMENT_UNKNOWN" });
    expect(f.balance()).toBe(0);
    expect(f.events).toEqual(["tasks", "reserve"]);
  });
  it("保存明确被拒绝时返还", async () => {
    const f = fixture(); f.store.save = async () => { throw new SaveRejectedError(); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "SAVE_FAILED_REFUNDED" });
    expect(f.balance()).toBe(1);
  });
  it("保存已提交但响应丢失时返回已存结果且不返还", async () => {
    const f = fixture(); const save = f.store.save;
    f.store.save = async (...args) => { await save(...args); throw new Error("lost response"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ status: "succeeded", plan: { id: "request-1" }, availableCredits: 0 });
    expect(f.plans.size).toBe(1);
    expect(f.events).not.toContain("refund");
  });
  it.each([false, true])("保存提交状态未知，核对失败=%s 时不返还", async lookupFails => {
    const f = fixture(); f.store.save = async () => { throw new Error("timeout"); };
    if (lookupFails) f.store.find = async () => { throw new Error("offline"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "SETTLEMENT_UNKNOWN", requestId: "request-1" });
    expect(f.balance()).toBe(0);
    expect(f.events).not.toContain("refund");
  });
  it.each([false, true])("返还提交后报错=%s 时仅尝试一次", async committed => {
    const f = fixture(); f.deps.generate = async () => { throw new Error("rejected"); };
    const refund = f.store.refund; let attempts = 0;
    f.store.refund = async id => { attempts++; if (committed) await refund(id); throw new Error("refund failure"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "SETTLEMENT_UNKNOWN" });
    expect(attempts).toBe(1);
    expect(f.balance()).toBe(committed ? 1 : 0);
  });
  it("保存成功后余额读取失败保留成功结果", async () => {
    const f = fixture(); f.store.credits = async () => { throw new Error("offline"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ status: "succeeded", availableCredits: null });
    expect(f.plans.size).toBe(1); expect(f.balance()).toBe(0);
  });
  it.each([null, {}, { tasks: [], taskItems: "invalid" }])("模型输出无效时返还额度 %s", async value => {
    const f = fixture(); f.deps.generate = async () => value;
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ code: "MODEL_FAILED_REFUNDED" });
    expect(f.balance()).toBe(1); expect(f.plans.size).toBe(0);
  });
  it("日志故障不会改变结算或多次返还", async () => {
    const f = fixture(); f.deps.log = () => { throw new Error("log transport"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ status: "succeeded" });
    expect(f.balance()).toBe(0);
  });
  it("无额度时在调用模型之前拒绝", async () => {
    const f = fixture(0);
    await expect(generateForUser("u1", { hours: 8 }, f.deps)).rejects.toMatchObject({ code: "NO_CREDITS" });
    expect(f.events).toEqual(["tasks", "reserve"]);
    expect(f.plans.size).toBe(0);
  });
  it("成功时预占、调用、保存，且只消费一个额度", async () => {
    const f = fixture(3);
    const result = await generateForUser("u1", { hours: 8 }, f.deps);
    expect(result).toMatchObject({ status: "succeeded", availableCredits: 2, plan: { id: "request-1", schedule } });
    expect(f.events).toEqual(["tasks", "reserve", "generate", "save", "credits"]);
    expect(f.balance()).toBe(2);
    expect(f.plans.size).toBe(1);
  });
  it("模型明确失败后恢复可用额度", async () => {
    const f = fixture();
    f.deps.generate = async () => { throw new Error("provider rejected"); };
    expect(await generateForUser("u1", { hours: 8 }, f.deps)).toMatchObject({ status: "failed", code: "MODEL_FAILED_REFUNDED", requestId: "request-1" });
    expect(f.balance()).toBe(1);
    expect(f.plans.size).toBe(0);
    expect(f.events.filter(e => e === "refund")).toHaveLength(1);
  });
  it.each([0, 25, NaN, Infinity, "8", null])("拒绝非法时长 %s 且不预占", async hours => {
    const f = fixture();
    await expect(generateForUser("u1", { hours }, f.deps)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(f.events).toEqual([]);
  });
  it.each([1, 1.5, 24])("接受边界时长 %s", async hours => {
    expect(await generateForUser("u1", { hours }, fixture().deps)).toMatchObject({ status: "succeeded" });
  });
  it("无任务时不预占", async () => {
    const f = fixture(); f.store.listTasks = async () => [];
    await expect(generateForUser("u1", { hours: 8 }, f.deps)).rejects.toBeInstanceOf(GenerationError);
    expect(f.events).toEqual([]);
  });
});
