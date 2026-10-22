import { Outlet } from "react-router";
import { logout, useAuth } from "wasp/client/auth";
import { getCreditBalance, useQuery } from "wasp/client/operations";
import { Link, routes } from "wasp/client/router";
import { DarkModeSwitcher } from "./components/DarkModeSwitcher";
import { Toaster } from "./components/ui/toaster";
import "./Main.css";

export function App() {
  const { data: user } = useAuth();
  // 余额以 getCreditBalance 为准：useAuth 里的 user 是登录时的快照，生成日程后不会刷新，
  // 直接用它会让页头一直显示旧额度（见 SPEC.md §5）。
  const { data: balance } = useQuery(getCreditBalance, undefined, {
    enabled: !!user,
  });
  const credits = balance?.credits ?? user?.credits;

  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border flex items-center justify-between border-b px-6 py-4">
        <Link to={routes.HomeRoute.to} className="font-semibold">任务规划实验室</Link>
        <div className="flex items-center gap-4 text-sm">
          {user && (
            <span data-testid="credit-balance">剩余额度： {credits ?? "…"}</span>
          )}
          <DarkModeSwitcher />
          {user && <button type="button" onClick={() => logout()}>退出登录</button>}
        </div>
      </header>
      <main className="mx-auto max-w-7xl"><Outlet /></main>
      <Toaster position="bottom-right" />
    </div>
  );
}
