import { Outlet } from "react-router";
import { logout, useAuth } from "wasp/client/auth";
import { Link, routes } from "wasp/client/router";
import { DarkModeSwitcher } from "./components/DarkModeSwitcher";
import { Toaster } from "./components/ui/toaster";
import "./Main.css";

export function App() {
  const { data: user } = useAuth();
  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border flex items-center justify-between border-b px-6 py-4">
        <Link to={routes.HomeRoute.to} className="font-semibold">任务规划实验室</Link>
        <div className="flex items-center gap-4 text-sm">
          <DarkModeSwitcher />
          {user && <button type="button" onClick={() => logout()}>退出登录</button>}
        </div>
      </header>
      <main className="mx-auto max-w-7xl"><Outlet /></main>
      <Toaster position="bottom-right" />
    </div>
  );
}
