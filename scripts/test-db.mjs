import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

function configuredApplicationUrls() {
  let fileUrl;
  try {
    fileUrl = parseEnv(readFileSync(new URL("../.env.server", import.meta.url), "utf8")).DATABASE_URL;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot read application database configuration for safety check");
  }
  return [process.env.DATABASE_URL, fileUrl].filter(Boolean);
}

/** Read application addresses only for comparison; never load them as the test target or into env. */
export function validateTestDatabaseUrl(value, applicationUrl) {
  if (!value) throw new Error("Set QUOTA_TEST_DATABASE_URL to an independent local *_quota_test database");
  const url = new URL(value);
  const local = host => ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !local(url.hostname) ||
    !/^\/[a-zA-Z0-9_]+_quota_test$/.test(url.pathname) ||
    [...url.searchParams.keys()].some(key => !["schema", "connection_limit"].includes(key)) ||
    (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public")) {
    throw new Error("Tests require a local *_quota_test database with public schema");
  }
  // null is reserved for the browser fixture, which intentionally targets its own disposable app DB.
  const applicationUrls = applicationUrl === null ? [] : applicationUrl !== undefined ? [applicationUrl] : configuredApplicationUrls();
  for (const address of applicationUrls) {
    let app;
    let database;
    try {
      app = new URL(address);
      if (!["postgres:", "postgresql:"].includes(app.protocol)) throw new Error();
      database = decodeURIComponent(app.pathname);
    } catch { throw new Error("Invalid application database configuration for safety check"); }
    if (local(app.hostname) && (app.port || "5432") === (url.port || "5432") && database === url.pathname) {
      throw new Error("Test database must differ from DATABASE_URL");
    }
  }
  return url.toString();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = validateTestDatabaseUrl(process.env.QUOTA_TEST_DATABASE_URL);
  const run = args => {
    const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", ...args], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  // Wasp generates auth models and copies the existing migrations here.
  run(["generate", "--schema", ".wasp/out/db/schema.prisma"]);
  run(["migrate", "deploy", "--schema", ".wasp/out/db/schema.prisma"]);
}
