import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["node_modules/**", "coverage/**", ".state/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.config.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Plain JavaScript config files have no types to check.
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // src/core is pure: it takes data in and gives data back. No network, files, database or process state, and no
    // imports from the code that does those things. That is what keeps it fast to test and impossible to tangle.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "pg", message: "src/core must not touch the database." },
            { name: "undici", message: "src/core must not do network I/O." },
          ],
          patterns: [
            {
              group: ["**/worker/**", "**/app/**", "**/local/**", "**/prisma/**", "@prisma/*"],
              message: "src/core must not import from the worker, the app or the database.",
            },
            {
              group: ["node:fs", "node:fs/*", "node:net", "node:http", "node:https", "node:dns", "node:child_process"],
              message: "src/core must not do input or output.",
            },
          ],
        },
      ],
    },
  },
]);
