// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoAppPage } from "../../src/demo-ai-app/DemoAppPage";
import * as api from "../helpers/clientOperations";

const schedule = { tasks: [{ name: "已保存的计划", priority: "medium" }], taskItems: [] };
let credits: number | undefined;
let creditsError: Error | null;
let tasksError: Error | null;
let plans: { content: string }[];
const refreshCredits = vi.fn();
const refreshPlans = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  credits = 1;
  creditsError = null;
  tasksError = null;
  plans = [{ content: JSON.stringify(schedule) }];
  refreshCredits.mockImplementation(async () => ({ data: credits }));
  refreshPlans.mockImplementation(async () => ({ data: plans }));
  api.useQuery.mockImplementation((query) => {
    if (query === api.getCredits) return { data: credits, error: creditsError, refetch: refreshCredits };
    if (query === api.getPlanResults) return { data: plans, refetch: refreshPlans };
    if (query === api.getAllTasksByUser) return {
      data: [{ id: "task-1", description: "待规划任务", time: "1", isDone: false }],
      error: tasksError, isLoading: false,
    };
    throw new Error("Unexpected query");
  });
});
afterEach(cleanup);

describe("A10: quota feedback and recovery in the real page", () => {
  it("disables zero-credit generation and shows the persisted schedule", () => {
    credits = 0;
    render(<DemoAppPage />);
    expect(screen.getByTestId("generate-schedule-button")).toBeDisabled();
    expect(screen.getByText("已保存的计划")).toBeInTheDocument();
    expect(api.generatePlan).not.toHaveBeenCalled();
  });

  it.each(["loading", "error"])("disables generation while balance is %s", (state) => {
    if (state === "loading") credits = undefined;
    else creditsError = new Error("offline");
    render(<DemoAppPage />);
    expect(screen.getByTestId("generate-schedule-button")).toBeDisabled();
    if (state === "error") expect(screen.getByText("暂时无法读取余额，请刷新后继续。")).toBeInTheDocument();
  });

  it("shows pending state, sends once, reports success and refreshes both authoritative views", async () => {
    const pending = Promise.withResolvers<typeof schedule>();
    api.generatePlan.mockReturnValue(pending.promise);
    refreshCredits.mockImplementation(async () => { credits = 0; return { data: 0 }; });
    render(<DemoAppPage />);
    const button = screen.getByTestId("generate-schedule-button");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("生成中");
    expect(api.generatePlan).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(schedule); await pending.promise; });
    expect(await screen.findByRole("status")).toHaveTextContent("已消耗 1 次额度");
    await waitFor(() => expect(button).toHaveTextContent("额度已用完"));
    expect(refreshCredits).toHaveBeenCalledTimes(1);
    expect(refreshPlans).toHaveBeenCalledTimes(1);
  });

  it("explains a confirmed provider failure and preserves the previous schedule for retry", async () => {
    api.generatePlan.mockRejectedValue({ statusCode: 502 });
    render(<DemoAppPage />);
    fireEvent.click(screen.getByTestId("generate-schedule-button"));
    expect(await screen.findByRole("status")).toHaveTextContent("本次未扣费");
    expect(screen.getByRole("status")).toHaveTextContent("删除包含 [fail] 的任务后重试");
    expect(screen.getByText("已保存的计划")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("generate-schedule-button")).toBeEnabled());
  });

  it("handles a stale one-credit page receiving 402 and refreshes the exhausted balance", async () => {
    api.generatePlan.mockRejectedValue({ statusCode: 402 });
    refreshCredits.mockImplementation(async () => { credits = 0; return { data: 0 }; });
    render(<DemoAppPage />);
    fireEvent.click(screen.getByTestId("generate-schedule-button"));
    expect(await screen.findByRole("status")).toHaveTextContent("本次未调用模型");
    await waitFor(() => expect(screen.getByTestId("generate-schedule-button")).toHaveTextContent("额度已用完"));
  });

  it("does not promise a refund when the response is lost", async () => {
    api.generatePlan.mockRejectedValue(new Error("Network error after possible commit"));
    render(<DemoAppPage />);
    fireEvent.click(screen.getByTestId("generate-schedule-button"));
    const message = await screen.findByRole("status");
    expect(message).toHaveTextContent("先刷新余额与最近日程");
    expect(message).not.toHaveTextContent("本次未扣费");
  });

  it("rejects invalid hours in the page before submitting", () => {
    render(<DemoAppPage />);
    fireEvent.change(screen.getByLabelText("今天可用的工作时长"), { target: { value: "25" } });
    expect(screen.getByRole("alert")).toHaveTextContent("1–24 小时");
    expect(screen.getByTestId("generate-schedule-button")).toBeDisabled();
    expect(api.generatePlan).not.toHaveBeenCalled();
  });

  it("disables generation when task loading failed", () => {
    tasksError = new Error("offline");
    render(<DemoAppPage />);
    expect(screen.getByTestId("generate-schedule-button")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("任务读取失败");
  });

  it("ignores invalid saved JSON without breaking generation", () => {
    plans = [{ content: "not-json" }];
    render(<DemoAppPage />);
    expect(screen.queryByTestId("schedule")).not.toBeInTheDocument();
    expect(screen.getByTestId("generate-schedule-button")).toBeEnabled();
  });
});
