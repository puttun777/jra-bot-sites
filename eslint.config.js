// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "data/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "scripts/*.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unnecessary-condition": "off",
      "no-console": "off",
      "@typescript-eslint/no-floating-promises": ["error", { allowForKnownSafeCalls: [{ from: "package", name: ["test", "describe", "it"], package: "node:test" }] }],
    },
  },
  {
    // jra-bot-web からコピーした画面（元は biome で検査）。イベントハンドラの async は元の書き方を保つ
    files: ["src/web/**/*.ts"],
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-unsafe-type-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
