// 画面（src/web）を 1 つの ES モジュールに束ね、静的ファイルと一緒に dist/public へ置く。
// あわせて Sites の Worker 入口（src/sites/worker.ts）を束ね、Node 専用 API（node:*）を含まないことを確かめる。
import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";

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

const sitesBuild = process.argv.includes("--sites");
const assetPaths = ["/index.html", "/style.css", "/js/app.js"];
const assets = Object.fromEntries(assetPaths.map((path) => [path, readFileSync(`dist/public${path}`, "utf8")]));
await build({
  entryPoints: ["src/sites/worker.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: sitesBuild ? "dist/server/index.js" : "dist/sites/worker.js",
  define: { SITES_STATIC_FILES: JSON.stringify(assets) },
  mainFields: ["module", "main"],
  conditions: ["worker", "browser", "import"],
  logLevel: "warning",
});

if (sitesBuild) {
  const output = "dist/.openai";
  const drizzle = `${output}/drizzle`;
  mkdirSync(`${drizzle}/meta`, { recursive: true });
  copyFileSync(".openai/hosting.json", `${output}/hosting.json`);
  const tags = ["0001_baseline", "0002_ops_calendar_ingest_ml", "0003_sites"];
  const sixDigits = "[0-9]".repeat(6);
  const fourHexDigits = "[0-9a-f]".repeat(4);
  for (const tag of tags) {
    const sql = readFileSync(`migrations/${tag}.sql`, "utf8").trimEnd();
    // D1 limits GLOB patterns to 50 bytes. Split the same matches into
    // shorter predicates in the hosted artifact, before any are applied.
    const d1Sql = sql
      .replaceAll(`race_id GLOB '${sixDigits.repeat(2)}'`, `substr(race_id, 1, 6) GLOB '${sixDigits}' AND substr(race_id, 7) GLOB '${sixDigits}'`)
      .replaceAll(`run_id GLOB '${fourHexDigits.repeat(2)}-*'`, `substr(run_id, 1, 4) GLOB '${fourHexDigits}' AND substr(run_id, 5) GLOB '${fourHexDigits}-*'`);
    for (const match of d1Sql.matchAll(/\bGLOB\s+'([^']*)'/g)) {
      if (Buffer.byteLength(match[1], "utf8") > 50) throw new Error(`D1 GLOB limit in ${tag}: ${match[0]}`);
    }
    const drizzleSql = d1Sql.replace(/;[ \t]*\r?\n/g, ";\n--> statement-breakpoint\n");
    writeFileSync(`${drizzle}/${tag}.sql`, `${drizzleSql}\n`);
  }
  const entries = tags.map((tag, idx) => ({ idx, version: "6", when: Date.UTC(2026, 10, 27) + idx, tag, breakpoints: true }));
  writeFileSync(`${drizzle}/meta/_journal.json`, JSON.stringify({ version: "7", dialect: "sqlite", entries }, null, 2) + "\n");
  rmSync("dist/public", { recursive: true });
  console.log("Sites: dist/server/index.js, dist/.openai");
} else {
  console.log("assets: dist/public, dist/sites/worker.js");
}
