/**
 * 测试环境下的 `wasp/server` 占位。
 *
 * 真实实现由 Wasp 在构建时生成，测试里不需要整条链路。
 * 被测试的函数都通过参数接收 client，所以这个 prisma 只负责在
 * 「有人忘了注入、直接用了全局 client」时立刻报错，避免测试静默地打到真库。
 */
export const prisma = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(
        `测试里不应访问 wasp/server 的 prisma（读取了 ${String(prop)}），请通过参数注入 client`,
      );
    },
  },
);
