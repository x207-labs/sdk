import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Tests use local sources through aliases, so `npm run build` is not needed first.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@x207\/core$/, replacement: local("./packages/core/src/index.ts") },
      { find: /^@x207\/scheme$/, replacement: local("./packages/scheme/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
  },
});
