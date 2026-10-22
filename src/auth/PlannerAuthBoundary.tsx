import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAuth } from "wasp/client/auth";
import { Button } from "../client/components/ui/button";

// Both planner routes use this boundary instead of Wasp's default wrapper,
// which unmounts the result page on every authentication refetch error.
export function PlannerAuthBoundary({ children }: { children: ReactNode }) {
  const { data: user, isLoading, isError, error, isFetching, refetch } = useAuth();
  const status = error && typeof error === "object" && "statusCode" in error
    ? error.statusCode : undefined;
  const temporary = status === undefined ||
    (typeof status === "number" && status >= 500 && status <= 599);

  // A cached identity only preserves the view through temporary failures.
  // The child disables generation while the shared auth query is in error.
  if (user && (!isError || temporary)) return children;
  if (isError) {
    return <div className="space-y-4 p-8">
      <p role="alert">{status === 401 || status === 403
        ? "登录已失效，请重新登录后再操作。"
        : "暂时无法验证登录状态，请重试。"}</p>
      <Button type="button" disabled={isFetching} onClick={() => { void refetch(); }}>
        重试身份验证
      </Button>
      <a href="/login" className="ml-4 underline">前往登录</a>
    </div>;
  }
  if (isLoading) return <p role="status" className="p-8">正在验证登录状态…</p>;
  return <Navigate to="/login" replace />;
}
