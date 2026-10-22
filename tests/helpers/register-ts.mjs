import { registerHooks } from "node:module";

// Node 24 strips types; source imports follow the app's extensionless TS style.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(specifier + ".ts", context);
      }
      throw error;
    }
  },
});
