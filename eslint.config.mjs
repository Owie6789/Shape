import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Build artifacts of `npm run build:runtime` (esbuild, minified) and the
  // vendored Tailwind browser build copied next to them. Linting generated
  // output only produces noise that hides real findings in source.
  globalIgnores(["src-tauri/runtime/**", "public/preview/**"]),
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
  ]),
]);

export default eslintConfig;
