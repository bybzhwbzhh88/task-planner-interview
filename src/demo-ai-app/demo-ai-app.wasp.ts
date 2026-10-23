import { action, page, query, route, type Spec } from "@wasp.sh/spec";

import { DemoAppPage } from "./DemoAppPage" with { type: "ref" };
import {
  createTask,
  deleteTask,
  generatePlan,
  getAllTasksByUser,
  getPlanResults,
  getCredits,
  updateTask,
} from "./operations" with { type: "ref" };

export const demoAiAppSpec: Spec = [
  route("DemoAppRoute", "/demo-app", page(DemoAppPage, { authRequired: true })),

  query(getCredits, { entities: ["User"] }),
  query(getPlanResults, { entities: ["User", "PlanResult"] }),
  action(generatePlan, { entities: ["User", "Task", "PlanResult"] }),

  query(getAllTasksByUser, { entities: ["Task"] }),
  action(createTask, { entities: ["Task"] }),
  action(updateTask, { entities: ["Task"] }),
  action(deleteTask, { entities: ["Task"] }),
];
