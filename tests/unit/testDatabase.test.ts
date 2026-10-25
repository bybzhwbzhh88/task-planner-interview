import { expect, it } from "vitest";
import { validateTestDatabaseUrl } from "../../scripts/test-db.mjs";

it.each([undefined, "postgresql://localhost/app", "postgresql://remote.example/a_quota_test", "postgresql://localhost/app_quota_test?schema=private", "file:foo"])('拒绝不安全测试库 %s', value => {
  expect(() => validateTestDatabaseUrl(value)).toThrow();
});
it("只接受显式本地专用测试库", () => {
  expect(validateTestDatabaseUrl("postgresql://quota:local@127.0.0.1:55439/generation_quota_test")).toContain("generation_quota_test");
});
it("测试库与应用库相同即拒绝（忽略用户与查询参数）", () => {
  expect(() => validateTestDatabaseUrl("postgresql://quota@localhost:55439/a_quota_test", "postgresql://other@127.0.0.1:55439/a_quota_test?schema=public")).toThrow();
});
