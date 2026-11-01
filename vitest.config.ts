import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Test memakai source lokal lewat alias, jadi tidak perlu `npm run build` lebih dulu.
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
