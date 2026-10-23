import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const file = ".wasp/persistence-probe.json";
try {
  if (process.argv[2] === "prepare") {
    if (fs.existsSync(file)) throw new Error("An unfinished persistence probe already exists");
    const id = randomUUID();
    const content = JSON.stringify({ tasks: [], taskItems: [] });
    // Record the ID first so cleanup remains possible after interruption.
    fs.writeFileSync(file, JSON.stringify({ id, content }));
    await db.user.create({ data: { id, credits: 2, planResults: { create: { content } } } });
    console.log("Persistence probe created; restart the application, then run check");
  } else if (process.argv[2] === "check") {
    const { id, content } = JSON.parse(fs.readFileSync(file, "utf8"));
    try {
      assert.equal((await db.user.findUniqueOrThrow({ where: { id } })).credits, 2);
      const plans = await db.planResult.findMany({ where: { userId: id } });
      assert.equal(plans.length, 1);
      assert.equal(plans[0].content, content);
      console.log("PASS: user balance and saved result survived application restart");
    } finally {
      await db.planResult.deleteMany({ where: { userId: id } });
      await db.user.deleteMany({ where: { id } });
      fs.unlinkSync(file);
    }
  } else {
    throw new Error("Usage: node --env-file=.env.server scripts/persistence-smoke.mjs prepare|check");
  }
} finally {
  await db.$disconnect();
}
