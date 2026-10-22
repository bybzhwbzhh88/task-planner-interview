import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, createWriteStream, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { once } from "node:events";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const flags = new Set(process.argv.slice(2));
if (flags.has("--help")) {
  console.log("npm run verify: install, compile, type-check and run all 17 real PostgreSQL tests.\nnpm run verify:all: additionally start an isolated app, run 35 HTTP cases and 15 Chromium browser steps.\nRequires Linux/WSL, Node >=24.14.1, Wasp 0.25.0, and either local PostgreSQL binaries or Docker. No .env files or database URL are needed.\nOptional TEST_DATABASE_URL must name a dedicated *_quota_test database with CREATEDB permission.\nOptional VERIFY_DB_DRIVER=docker forces Docker; --database-only omits type checks.");
  process.exit(0);
}
if ([...flags].some((flag) => !["--e2e", "--database-only"].includes(flag))) throw new Error("Unknown verification argument; use --help.");
const reportDir = resolve("test-results/quota");
mkdirSync(reportDir, { recursive: true });
const runtime = mkdtempSync(join(reportDir, "runtime-"));
const started = Date.now();
const summary = { startedAt: new Date().toISOString(), mode: flags.has("--e2e") ? "all" : flags.has("--database-only") ? "database" : "core", stages: [], passed: false };
const env = { ...process.env, WASP_TELEMETRY_DISABLE: "1" };
let databaseUrl = env.TEST_DATABASE_URL;
let nativeBin;
let nativeStarted = false;
let container;
let app;
let appLog;
let cleaning = false;

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20_000, ...options });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function validateDatabase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("TEST_DATABASE_URL is not a valid PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^[a-z][a-z0-9_]*_quota_test$/.test(url.pathname.slice(1))) {
    throw new Error("Refusing database access: TEST_DATABASE_URL must name a dedicated *_quota_test database.");
  }
  return url;
}
async function run(name, command, args, childEnv = env) {
  console.log("\n[verify] " + name);
  const stage = { name, startedAt: new Date().toISOString() };
  summary.stages.push(stage);
  const output = createWriteStream(join(reportDir, name + ".log"));
  const child = spawn(command, args, { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => { output.write(data); process.stdout.write(data); });
  child.stderr.on("data", (data) => { output.write(data); process.stderr.write(data); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 600_000);
  try {
    const code = await new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", resolveCode);
    });
    stage.exitCode = code;
    if (code !== 0) throw new Error(name + " failed; see test-results/quota/" + name + ".log");
  } finally {
    clearTimeout(timer);
    stage.finishedAt = new Date().toISOString();
    output.end();
  }
}
async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}
async function ensureFree(port) {
  const listener = createServer();
  await new Promise((done, reject) => listener.once("error", () => reject(new Error("Port " + port + " is in use; stop that app before verify:all."))).listen(port, "127.0.0.1", done));
  await new Promise((done) => listener.close(done));
}
async function prepareDatabase() {
  if (databaseUrl) {
    validateDatabase(databaseUrl);
    summary.database = "explicit isolated TEST_DATABASE_URL";
    nativeBin = env.VERIFY_PG_BIN;
    return;
  }
  const configured = env.VERIFY_PG_BIN || capture("pg_config", ["--bindir"]);
  if (env.VERIFY_DB_DRIVER !== "docker" && configured && existsSync(join(configured, "initdb")) && process.getuid?.() !== 0) {
    nativeBin = configured;
    const port = await freePort();
    const data = join(runtime, "pgdata");
    await run("database-init", join(nativeBin, "initdb"), ["-D", data, "-U", "quota_verify", "--auth=trust", "--no-locale", "-E", "UTF8"]);
    await run("database-start", join(nativeBin, "pg_ctl"), ["-D", data, "-l", join(runtime, "postgres.log"), "-o", "-h 127.0.0.1 -p " + port + " -k /tmp", "-w", "start"]);
    nativeStarted = true;
    await run("database-create", join(nativeBin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", "quota_verify", "task_planner_verify_quota_test"]);
    databaseUrl = "postgresql://quota_verify@127.0.0.1:" + port + "/task_planner_verify_quota_test";
    summary.database = "disposable local PostgreSQL cluster";
  } else {
    if (!capture("docker", ["info", "--format", "{{.ServerVersion}}"])) throw new Error("No local PostgreSQL server tools or accessible Docker engine. Start Docker and rerun npm run verify.");
    container = "task-planner-verify-" + randomBytes(6).toString("hex");
    const password = randomBytes(24).toString("hex");
    await run("database-start", "docker", ["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=quota_verify", "--env", "POSTGRES_PASSWORD=" + password, "--env", "POSTGRES_DB=task_planner_verify_quota_test", "postgres:16"]);
    const endpoint = capture("docker", ["port", container, "5432/tcp"]);
    const port = endpoint?.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("Could not determine isolated PostgreSQL port.");
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (capture("docker", ["exec", container, "pg_isready", "-U", "quota_verify", "-d", "task_planner_verify_quota_test"]) !== undefined) { ready = true; break; }
      await new Promise((done) => setTimeout(done, 500));
    }
    if (!ready) throw new Error("Isolated PostgreSQL did not become ready.");
    databaseUrl = "postgresql://quota_verify:" + password + "@127.0.0.1:" + port + "/task_planner_verify_quota_test";
    env.VERIFY_DB_CONTAINER = container;
    summary.database = "disposable Docker PostgreSQL";
  }
  validateDatabase(databaseUrl);
}
async function waitForApp() {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (app.exitCode !== null) throw new Error("Verification app exited; see " + join(runtime, "server.log"));
    try {
      const [front, api] = await Promise.all([
        fetch("http://localhost:3000", { signal: AbortSignal.timeout(1000) }),
        fetch("http://localhost:3001/auth/me", { signal: AbortSignal.timeout(1000) }),
      ]);
      if (front.ok && [200, 401].includes(api.status)) return;
    } catch { /* wait for initial compilation */ }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("Verification app startup timed out; see " + join(runtime, "server.log"));
}
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (app && app.exitCode === null) {
    try { process.kill(-app.pid, "SIGTERM"); } catch { /* already stopped */ }
    await Promise.race([once(app, "close"), new Promise((done) => setTimeout(done, 5000))]);
    try { process.kill(-app.pid, "SIGKILL"); } catch { /* process group gone */ }
  }
  appLog?.end();
  if (container) {
    const stopped = spawnSync("docker", ["stop", "--time", "5", container], { stdio: "ignore", timeout: 20_000 });
    if (stopped.status !== 0) { summary.cleanupError = "Could not stop this run\'s Docker database."; summary.passed = false; process.exitCode = 1; }
  }
  if (nativeStarted) {
    const stopped = spawnSync(join(nativeBin, "pg_ctl"), ["-D", join(runtime, "pgdata"), "-m", "immediate", "-w", "stop"], { stdio: "ignore", timeout: 20_000 });
    // Never remove a cluster if its shutdown could not be confirmed.
    if (stopped.status === 0) rmSync(join(runtime, "pgdata"), { recursive: true, force: true });
    else { summary.cleanupError = "Could not stop this run\'s local database."; summary.passed = false; process.exitCode = 1; }
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
  await cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
});
try {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && (minor < 14 || (minor === 14 && patch < 1)))) throw new Error("Node >=24.14.1 is required.");
  if (process.platform !== "linux") throw new Error("Run in Linux or Ubuntu/WSL's Linux filesystem, as required by README.");
  if (!capture("wasp", ["version"])?.includes("0.25.0")) throw new Error("Install Wasp 0.25.0: npm install -g @wasp.sh/wasp-cli@0.25.0");
  if (databaseUrl) validateDatabase(databaseUrl);
  if (flags.has("--e2e")) {
    await ensureFree(3000);
    await ensureFree(3001);
    if (existsSync(".env.server") && parseEnv(readFileSync(".env.server", "utf8")).DATABASE_URL) {
      throw new Error("verify:all must run in a clean checkout without an application DATABASE_URL in .env.server. It never overwrites local configuration; use npm run verify for core tests here.");
    }
  }
  await prepareDatabase();
  env.TEST_DATABASE_URL = databaseUrl;
  env.DATABASE_URL = databaseUrl;
  if (nativeBin) env.VERIFY_PG_BIN = nativeBin;
  await run("install", "wasp", ["install"]);
  await run("compile", "wasp", ["compile"]);
  if (!flags.has("--database-only")) {
    await run("typescript-src", process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.src.json", "--noEmit"]);
    await run("typescript-wasp", process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.wasp.json", "--noEmit"]);
  }
  await run("migrations", process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", ".wasp/out/db/schema.prisma"]);
  await run("database-tests", process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.server.config.ts", "tests/quota.integration.test.ts"]);
  const dbReport = JSON.parse(readFileSync(join(reportDir, "vitest.json"), "utf8"));
  summary.databaseTests = { passed: dbReport.numPassedTests, failed: dbReport.numFailedTests, skipped: dbReport.numPendingTests };
  if (flags.has("--e2e")) {
    await run("browser-install", process.execPath, ["node_modules/playwright/cli.js", "install", ...(env.CI ? ["--with-deps"] : []), "chromium"]);
    const serverLog = join(runtime, "server.log");
    const databaseEnv = join(runtime, "database.env");
    writeFileSync(databaseEnv, "DATABASE_URL=" + databaseUrl + "\n", { mode: 0o600 });
    appLog = createWriteStream(serverLog);
    app = spawn("wasp", ["start"], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    app.stdout.pipe(appLog, { end: false });
    app.stderr.pipe(appLog, { end: false });
    await waitForApp();
    await run("http-tests", process.execPath, ["scripts/verify-quota.mjs", "--server-log", serverLog, "--database-env", databaseEnv, "--rounds", "10"]);
    await run("browser-tests", process.execPath, ["scripts/verify-browser.cjs"], { ...env, SERVER_LOG: serverLog, BROWSER_CHANNEL: "" });
    const http = JSON.parse(readFileSync(join(reportDir, "http.json"), "utf8"));
    const browser = JSON.parse(readFileSync(join(reportDir, "browser/report.json"), "utf8"));
    summary.httpCases = http.cases.length;
    summary.browserSteps = browser.steps.length;
    summary.pageErrors = browser.pageErrors.length;
  }
  summary.passed = true;
} catch (error) {
  // Do not echo environment values or database URLs.
  summary.error = error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "<database URL>");
  console.error("\n[verify] FAIL: " + summary.error);
  process.exitCode = 1;
} finally {
  await cleanup();
  summary.finishedAt = new Date().toISOString();
  summary.durationSeconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(reportDir, "verify-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log("\n[verify] " + (summary.passed ? "PASS" : "FAIL") + "; report: test-results/quota/verify-summary.json; " + summary.durationSeconds + "s");
}
