import { parseEnv } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REJECTION =
  "QUOTA_TEST_DATABASE_URL 必须显式指向独立的 PostgreSQL 测试库（库名以 _quota_test 结尾，且不能与应用 DATABASE_URL 相同）。";

function databaseIdentity(raw) {
  const url = new URL(raw);
  if (!["postgresql:", "postgres:"].includes(url.protocol)) {
    throw new Error("unsupported protocol");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!database || database.includes("/")) {
    throw new Error("invalid database name");
  }
  let host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (["localhost", "127.0.0.1", "[::1]"].includes(host)) host = "loopback";
  return { database, key: `${host}:${url.port || "5432"}/${database}` };
}

/**
 * 只接受显式给出的独立测试库。拒绝缺失、非 PostgreSQL、库名不以
 * _quota_test 结尾、或与应用 DATABASE_URL 指向同一数据库的输入。
 * 抛出的错误不包含原始 URL/口令。
 */
export function requireTestDatabaseUrl(raw, applicationUrl) {
  try {
    if (!raw) throw new Error("missing");
    const test = databaseIdentity(raw);
    if (!/_quota_test$/u.test(test.database)) throw new Error("not a test database");
    if (applicationUrl && databaseIdentity(applicationUrl).key === test.key) {
      throw new Error("application database");
    }
    return raw;
  } catch {
    throw new Error(REJECTION);
  }
}

/** 读取项目根目录 .env.server 中的 DATABASE_URL（如果存在），用于避免误连应用库。 */
export function resolveTestDatabaseUrl(
  raw = process.env.QUOTA_TEST_DATABASE_URL,
  applicationUrl = process.env.DATABASE_URL,
  projectRoot = fileURLToPath(new URL("../", import.meta.url)),
) {
  const checked = requireTestDatabaseUrl(raw, applicationUrl);
  const envPath = join(projectRoot, ".env.server");
  if (!existsSync(envPath)) return checked;

  let fromFile;
  try {
    fromFile = parseEnv(readFileSync(envPath, "utf8")).DATABASE_URL;
  } catch {
    throw new Error(REJECTION);
  }
  return requireTestDatabaseUrl(checked, fromFile);
}
