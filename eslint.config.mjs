import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // CommonJS build tooling, run directly by node — `require` is correct here.
    files: ["src-tauri/scripts/**/*.js", "scripts/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src-tauri/target/**",
    // One-off migration scripts not part of app
    "src-tauri/scripts/**",
    // Generated docs search index
    "docs/generated/**",
    // Generated preview runtime bundles (esbuild output)
    "src-tauri/runtime/**",
    "public/preview/**",
    // Coverage
    "coverage/**",
  ]),
]);

export default eslintConfig;
