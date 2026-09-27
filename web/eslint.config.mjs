import { defineConfig, globalIgnores } from "eslint/config";
import { fixupConfigRules } from "@eslint/compat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  // eslint-config-next の中の eslint-plugin-react / import / jsx-a11y は ESLint 10 に対応していない
  // (ESLint 10 で消えた context.getFilename() などを使う)。@eslint/compat で消えた API を補って動かす
  ...fixupConfigRules([...nextVitals, ...nextTs]),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
