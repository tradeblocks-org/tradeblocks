import nextPlugin from "@next/eslint-plugin-next";
import reactPlugin from "eslint-plugin-react";
import hooksPlugin from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "dist/**",
      "packages/*/dist/**",
      "packages/*/server/**",
      "next-env.d.ts",
      ".claude/hooks/**",
      ".claude/worktrees/**",
      ".worktrees/**",
    ],
  },
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    plugins: {
      "@next/next": nextPlugin,
      "react": reactPlugin,
      "react-hooks": hooksPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // IMPORT BOUNDARY: block reverse-direction imports from sibling consumers.
  // tradeblocks is a public library; no consumer module may leak into it.
  // Paired with tsconfig `paths` lockdown and the CI "Reverse import gate".
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../holodeck/*", "**/../holodeck/*"],
              message:
                "Imports from sibling consumer repos are forbidden. tradeblocks must not depend on holodeck or any private sibling.",
            },
            {
              group: ["**/private-packages/*"],
              message:
                "private-packages/* is reserved for private consumers. Public tradeblocks code must not import from it.",
            },
            {
              group: ["@tradeblocks-private/*"],
              message:
                "@tradeblocks-private/* is a private scope. Public tradeblocks code must not import from it.",
            },
          ],
        },
      ],
    },
  },
  // Must be last: turns off ESLint stylistic rules that conflict with Prettier
  // (Prettier owns formatting). See ADR 0037 (enterprise).
  eslintConfigPrettier,
);
