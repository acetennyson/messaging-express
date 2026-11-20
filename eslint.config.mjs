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
  // Allowed in lib/hosted/ (the one bridge, including its pool), the test helper, tests and server.ts.
  // packages/server/src/core/package-rules.test.ts enforces the same rules in CI; this gives the same answer in the editor.
  {
    files: ["packages/server/src/**/*.ts", "app/**/*.ts"],
    ignores: ["packages/server/src/core/testing.ts", "**/*.test.ts"],
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
