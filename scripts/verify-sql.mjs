import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// AC21 still executes both original SQL files with PostgreSQL's own client.
// Managed Docker verification uses the container's client, without a host psql.
const container = process.env.VERIFY_DB_CONTAINER;
const command = container ? "docker" : process.env.VERIFY_PG_BIN ? join(process.env.VERIFY_PG_BIN, "psql") : "psql";
const options = ["--no-psqlrc", "--set", "ON_ERROR_STOP=1"];
const args = container
  ? ["exec", "--interactive", "--env", "PGUSER", "--env", "PGPASSWORD", "--env", "PGDATABASE", container, "psql", ...options]
  : options;
const result = spawnSync(command, args, {
  input: readFileSync(0), encoding: "utf8", env: process.env,
});
if (result.error) {
  console.error("PostgreSQL SQL client could not start. Run npm run verify for managed setup.");
  process.exit(1);
}
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
