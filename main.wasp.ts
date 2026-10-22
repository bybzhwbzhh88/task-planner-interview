/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { app, page, route } from "@wasp.sh/spec";
import { App } from "./src/client/App" with { type: "ref" };
import { DemoAppPage } from "./src/demo-ai-app/DemoAppPage" with { type: "ref" };
import { NotFoundPage } from "./src/client/components/NotFoundPage" with { type: "ref" };
import { authConfig, authSpec } from "./src/auth/auth.wasp";
import { demoAiAppSpec } from "./src/demo-ai-app/demo-ai-app.wasp";

export default app({
  name: "TaskPlannerLab",
  wasp: { version: "^0.25.0" },
  title: "任务规划实验室",
  head: ["<link rel='icon' href='/favicon.svg' />"],
  auth: authConfig,
  client: { rootComponent: App },
  spec: [
    route("HomeRoute", "/", page(DemoAppPage)),
    route("NotFoundRoute", "*", page(NotFoundPage)),
    authSpec,
    demoAiAppSpec,
  ],
});
