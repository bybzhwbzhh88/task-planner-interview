import type { GeneratedSchedule } from "./schedule";

type QueryResult<T> = { data?: T; error?: unknown };
type Dependencies = {
  loadQuota: () => Promise<QueryResult<{ availableCredits: number; processingCount: number }>>;
  loadResults: () => Promise<QueryResult<{ content: string }[]>>;
  onResult: (result: GeneratedSchedule | null) => void;
  onMessage: (message: string) => void;
};

/** Resolve both reads before replacing an old generation error with a refresh outcome. */
export async function refreshQuotaResults({ loadQuota, loadResults, onResult, onMessage }: Dependencies) {
  const [quota, results] = await Promise.allSettled([loadQuota(), loadResults()]);
  const quotaReady = quota.status === "fulfilled" && !quota.value.error && !!quota.value.data;
  const resultsReady = results.status === "fulfilled" && !results.value.error && !!results.value.data;
  if (!resultsReady || results.status !== "fulfilled") {
    onMessage(quotaReady
      ? "额度已刷新，但最近结果读取失败，请稍后刷新；本次刷新不会生成或扣费。"
      : "额度与最近结果读取失败，请稍后刷新；本次刷新不会生成或扣费。");
    return;
  }

  const latest = results.value.data?.[0];
  let schedule: GeneratedSchedule | null = null;
  if (latest) {
    try {
      schedule = JSON.parse(latest.content) as GeneratedSchedule;
    } catch {
      onMessage(quotaReady
        ? "额度已刷新，但已保存的结果无法读取，请联系维护者核查；本次刷新未扣费。"
        : "额度读取失败，且已保存的结果无法读取，请稍后刷新或联系维护者核查；本次刷新未扣费。");
      return;
    }
  }
  onResult(schedule);
  if (!quotaReady) {
    onMessage(latest
      ? "最近结果已刷新，但额度读取失败，请再刷新额度；本次刷新不会生成或扣费。"
      : "目前没有已保存的日程，且额度读取失败，请稍后刷新；本次刷新不会生成或扣费。");
    return;
  }
  onMessage(latest
    ? "已刷新额度与最近成功结果，请核对下方日程；本次刷新不会生成或扣费。"
    : "已刷新额度，目前没有已保存的日程；本次刷新不会生成或扣费。");
}
