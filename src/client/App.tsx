import { Outlet } from "react-router";
import { logout, useAuth } from "wasp/client/auth";
import { getQuota, useQuery } from "wasp/client/operations";
import { Link, routes } from "wasp/client/router";
import { DarkModeSwitcher } from "./components/DarkModeSwitcher";
import { Toaster } from "./components/ui/toaster";
import "./Main.css";

export function App() {
  const { data: user } = useAuth();
  const quota = useQuery(getQuota, undefined, {
    enabled: !!user,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border flex items-center justify-between border-b px-6 py-4">
        <Link to={routes.HomeRoute.to} className="font-semibold">任务规划实验室</Link>
        <div className="flex items-center gap-4 text-sm">
          {user && <span>可用额度： {quota.isError ? "暂不可用" : quota.data?.availableCredits ?? "读取中…"}</span>}
          <DarkModeSwitcher />
          {user && <button type="button" onClick={() => logout()}>退出登录</button>}
        </div>
      </header>
      <main className="mx-auto max-w-7xl"><Outlet /></main>
      <Toaster position="bottom-right" />
    </div>
  );
}
