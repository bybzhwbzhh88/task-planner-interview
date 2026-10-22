import { PrismaClient } from "@prisma/client";
import { generatePlanForUser } from "../../src/demo-ai-app/planService";
import { PlanError } from "../../src/demo-ai-app/planError";

const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
console.info = (line: string) => { process.send?.({ type: "log", line }); };
process.once("message", async (message: { userId: string }) => {
  try {
    await generatePlanForUser({ hours: 8 }, { id: message.userId }, { db });
    process.send?.({ type: "done", status: 200 });
  } catch (error) {
    process.send?.({ type: "done", status: error instanceof PlanError ? error.statusCode : 599 });
  } finally {
    await db.$disconnect();
    process.disconnect?.();
  }
});
process.send?.({ type: "ready" });
