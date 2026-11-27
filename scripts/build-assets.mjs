// 画面（src/web）を 1 つの ES モジュールに束ね、静的ファイルと一緒に dist/public へ置く。
// あわせて Sites の Worker 入口（src/sites/worker.ts）を束ね、Node 専用 API（node:*）を含まないことを確かめる。
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/public/js", { recursive: true });
cpSync("src/web/static", "dist/public", { recursive: true });
await build({
  entryPoints: ["src/web/app.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/public/js/app.js",
  minify: false,
  legalComments: "none",
  logLevel: "warning",
});
await build({
  entryPoints: ["src/sites/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: "dist/sites/worker.js",
  mainFields: ["module", "main"],
  conditions: ["worker", "browser", "import"],
  logLevel: "warning",
});
console.log("assets: dist/public, dist/sites/worker.js");
