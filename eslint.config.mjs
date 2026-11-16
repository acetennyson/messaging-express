import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "packages/*/dist/**",
  ]),
  // The core takes everything through its ServerContext: no environment, no process-wide singletons.
  // Allowed in lib/hosted/ (the one bridge), lib/core/testing.ts, lib/db/pool.ts (hosted pool), tests and server.ts.
  // lib/core/no-raw-tables.test.ts enforces the same rules in CI; this gives the same answer in the editor.
  {
    files: ["lib/**/*.ts", "app/**/*.ts"],
    ignores: ["lib/hosted/**", "lib/core/testing.ts", "lib/db/pool.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: "Read configuration through ctx.config; only lib/hosted/ may read process.env." },
      ],
      "no-restricted-globals": ["error", { name: "globalThis", message: "No process-wide singletons in the core; keep state on the ServerContext." }],
    },
  },
]);

export default eslintConfig;
