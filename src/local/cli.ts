/**
 * ローカル用 CLI（本番の Sites では使わない）。
 *   migrate                         マイグレーションを適用
 *   seed-demo [--date YYYY-MM-DD]   **合成データ**（source=demo-synthetic）を投入（画面の確認用。実データではない）
 *   import <file.json>              取込の封筒（または封筒の配列）を取り込む（MCP と同じ検査）
 *   import-csv <kind> <file.csv> --observed-at <ISO>   kind = win-odds | results | payouts
 *   analyze [--date YYYY-MM-DD]     判定を実行
 *   backup <out.sqlite>             DB ファイルの複製（VACUUM INTO）
 *   restore <in.sqlite>             DB ファイルを置き換える（現在の DB は .bak に退避）
 *   export <out.json> [--from --to] JSON エクスポート
 *   legacy-export <old.sqlite> <out.json> [--from YYYY-MM-DD --to YYYY-MM-DD]
 *                                   旧 jra-bot の SQLite → 取込の封筒（JSON）。**実データなので Git に入れない**（data/ 配下を推奨）
 *   legacy-import <old.sqlite> [--from --to]   旧 SQLite をローカル DB へ取込（封筒を作って ingestBatch に通す）
 *   backtest --from YYYY-MM-DD --to YYYY-MM-DD   過去日を発走前のオッズだけで再判定し、紙上成績を出す（DB のコピーで実行を推奨）
 *   push <envelopes.json> --url https://<site>  封筒をサイトの /api/v1/ingest/batches へ送る（トークンは環境変数 INGEST_TOKEN）
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createServices, ingestBatch, performanceReport, runAnalysis } from "../application/services.js";
import { IngestEnvelopeRequest } from "../api/schemas.js";
import { addDays, jstDate, jstToInstant, systemClock, uuid } from "../domain/race.js";
import { NodeSqliteDatabase } from "../infrastructure/db/nodeSqlite.js";
import { migrate } from "./migrate.js";
import { csvToRecords } from "../integrations/csvImport.js";
import { convertLegacy } from "./legacy.js";

const dbPath = process.env["LOCAL_DB_PATH"] ?? "data/local.sqlite";
const [cmd, ...rest] = process.argv.slice(2);

function opt(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

function open(): NodeSqliteDatabase {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new NodeSqliteDatabase(dbPath);
  migrate(db, "migrations");
  return db;
}

async function ensureCliAgent(s: ReturnType<typeof createServices>): Promise<void> {
  if ((await s.agents.find(1, "local-cli")) === null) {
    await s.agents.create(1, { agentId: "local-cli", name: "ローカル CLI", tokenHash: "0".repeat(64), expiresAt: "2099-12-31T00:00:00.000Z", createdBy: "local" }, new Date().toISOString());
  }
}

async function main(): Promise<void> {
  switch (cmd) {
    case "migrate": {
      const db = new NodeSqliteDatabase(dbPath);
      console.log(migrate(db, "migrations").join("\n") || "up to date");
      return;
    }
    case "seed-demo": {
      const s = createServices(open(), systemClock);
      await ensureCliAgent(s);
      const date = opt("--date") ?? jstDate(new Date());
      const ymd = date.replaceAll("-", "");
      const r1 = `${ymd}0511`;
      const r2 = `${ymd}0512`;
      const created = addDays(date, -1).replaceAll("-", "");
      const obs = new Date().toISOString();
      const records = [
        { id: "NYS", data: { date: ymd, venue: "05", kai: 5, nichime: 8, status: "PLANNED", replacedBy: null } },
        { id: "NRA", data: { raceId: r1, kubun: "2", createdOn: created, postTime: "1540", raceName: "合成記念（デモ）", kai: 5, nichime: 8 } },
        { id: "NRA", data: { raceId: r2, kubun: "2", createdOn: created, postTime: "1625", raceName: "合成ステークス（デモ）", kai: 5, nichime: 8 } },
      ] as const;
      console.log(await ingestBatch(s, "local-cli", { batchId: uuid(), source: "demo-synthetic", observedAt: obs, records: records.map((r) => ({ id: r.id, payload: JSON.stringify(r.data) })) }));
      const oddsAt = new Date(Date.parse(jstToInstant(date, "15:20"))).toISOString();
      const win = [3.1, 4.6, 6.8, 11.5, 24.0, 41.0].map((o, i) => ({ umaban: i + 1, odds: o, pop: i + 1 }));
      const wide = [[1, 2, 3.9, 5.8], [1, 3, 5.5, 8.5], [1, 4, 8.7, 13.9], [2, 3, 7.8, 12.3], [2, 4, 12.6, 20.4], [3, 4, 19.1, 31.1]].map(([a, b, l, h]) => ({ a, b, low: l, high: h, pop: null }));
      const tri = [[1, 2, 3, 12.5], [1, 2, 4, 20.7], [1, 3, 4, 31.6], [2, 3, 4, 46.9]].map(([a, b, c, o]) => ({ a, b, c, odds: o, pop: null }));
      const oddsRecs = [r1, r2].flatMap((rid) => [
        { id: "NOW", payload: JSON.stringify({ raceId: rid, entries: win }) },
        { id: "NOD", payload: JSON.stringify({ raceId: rid, entries: wide }) },
        { id: "NOS", payload: JSON.stringify({ raceId: rid, entries: tri }) },
      ]);
      console.log(await ingestBatch(s, "local-cli", { batchId: uuid(), source: "demo-synthetic", observedAt: oddsAt, records: oddsRecs }));
      const resultRecs = [
        { id: "NRS", payload: JSON.stringify({ raceId: r1, entries: [1, 2, 3, 4, 5, 6].map((u) => ({ umaban: u, finish: [2, 1, 3, 4, 6, 5][u - 1] })) }) },
        { id: "NHR", payload: JSON.stringify({ raceId: r1, market: "win", provisional: false, entries: [{ key: "02", payout: 460 }] }) },
        { id: "NHR", payload: JSON.stringify({ raceId: r1, market: "wide", provisional: false, entries: [{ key: "01-02", payout: 470 }, { key: "01-03", payout: 650 }, { key: "02-03", payout: 900 }] }) },
        { id: "NHR", payload: JSON.stringify({ raceId: r1, market: "sanrenpuku", provisional: false, entries: [{ key: "01-02-03", payout: 1250 }] }) },
      ];
      console.log(await ingestBatch(s, "local-cli", { batchId: uuid(), source: "demo-synthetic", observedAt: new Date(Date.parse(jstToInstant(date, "15:45"))).toISOString(), records: resultRecs }));
      console.log("合成データを投入しました（実データではありません）。");
      return;
    }
    case "import": {
      const file = rest[0];
      if (file === undefined) throw new Error("ファイルを指定してください");
      const s = createServices(open(), systemClock);
      await ensureCliAgent(s);
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      for (const e of Array.isArray(raw) ? raw : [raw]) {
        const env = IngestEnvelopeRequest.parse(e);
        console.log(await ingestBatch(s, "local-cli", { batchId: env.batchId, source: env.source, observedAt: new Date(env.observedAt).toISOString(), records: env.records.map((r) => ({ id: r.id, payload: JSON.stringify(r.data) })) }));
      }
      return;
    }
    case "import-csv": {
      const [kind, file] = rest;
      const observedAt = opt("--observed-at");
      if (kind === undefined || file === undefined || observedAt === undefined || Number.isNaN(Date.parse(observedAt))) throw new Error("import-csv <kind> <file> --observed-at <ISO>");
      const s = createServices(open(), systemClock);
      await ensureCliAgent(s);
      const recs = csvToRecords(kind, readFileSync(file, "utf8"));
      console.log(await ingestBatch(s, "local-cli", { batchId: uuid(), source: "csv-import", observedAt: new Date(observedAt).toISOString(), records: recs.map((r) => ({ id: r.id, payload: JSON.stringify(r.data) })) }));
      return;
    }
    case "analyze": {
      const s = createServices(open(), systemClock);
      const date = opt("--date");
      console.log(JSON.stringify(await runAnalysis(s, { ...(date === undefined ? {} : { date }), trigger: "MANUAL", actor: "local-cli" }), null, 2));
      return;
    }
    case "backup": {
      const out = rest[0];
      if (out === undefined || existsSync(out)) throw new Error("出力先を指定してください（既存のファイルは上書きしない）");
      const db = open();
      db.raw.prepare("VACUUM INTO ?").run(out);
      console.log(`backup: ${out}`);
      return;
    }
    case "restore": {
      const src = rest[0];
      if (src === undefined || !existsSync(src)) throw new Error("復元元を指定してください");
      if (existsSync(dbPath)) renameSync(dbPath, `${dbPath}.${Date.now()}.bak`);
      copyFileSync(src, dbPath);
      const db = new NodeSqliteDatabase(dbPath);
      const ok = db.raw.prepare("PRAGMA integrity_check").get();
      console.log(`restore: ${src} → ${dbPath} (${JSON.stringify(ok)})`);
      return;
    }
    case "export": {
      const out = rest[0];
      if (out === undefined) throw new Error("出力先を指定してください");
      const db = open();
      const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'").all().map((r) => String(r["name"]));
      const data: Record<string, unknown[]> = {};
      for (const t of tables) data[t] = db.raw.prepare(`SELECT * FROM "${t.replaceAll('"', "")}"`).all();
      writeFileSync(out, JSON.stringify({ format: "jra-bot-sites/full-export/v1", exportedAt: new Date().toISOString(), tables: data }));
      console.log(`export: ${out}`);
      return;
    }
    case "legacy-export": {
      const [src, out] = rest;
      if (src === undefined || out === undefined || existsSync(out)) throw new Error("legacy-export <old.sqlite> <out.json>（出力先は新しいファイル）");
      const r = convertLegacy(src, { ...(opt("--from") === undefined ? {} : { from: opt("--from") }), ...(opt("--to") === undefined ? {} : { to: opt("--to") }) });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(r.envelopes));
      console.log(JSON.stringify(r.report, null, 2));
      return;
    }
    case "legacy-import": {
      const src = rest[0];
      if (src === undefined) throw new Error("legacy-import <old.sqlite>");
      const r = convertLegacy(src, { ...(opt("--from") === undefined ? {} : { from: opt("--from") }), ...(opt("--to") === undefined ? {} : { to: opt("--to") }) });
      const s = createServices(open(), systemClock);
      await ensureCliAgent(s);
      const total = { applied: 0, unchanged: 0, duplicates: 0, deferred: 0, rejected: 0, quarantined: 0, replayed: 0, duplicateBatches: 0 };
      for (const env of r.envelopes) {
        const x = await ingestBatch(s, "local-cli", { batchId: env.batchId, source: env.source, observedAt: env.observedAt, records: env.records.map((rec) => ({ id: rec.id, payload: JSON.stringify(rec.data) })) });
        if (x.status === "DUPLICATE_BATCH") total.duplicateBatches++;
        total.applied += x.applied;
        total.unchanged += x.unchanged;
        total.duplicates += x.duplicates;
        total.deferred += x.deferred;
        total.rejected += x.rejected;
        total.quarantined += x.quarantined;
        total.replayed += x.replayed;
      }
      console.log(JSON.stringify({ conversion: r.report, ingest: total }, null, 2));
      return;
    }
    case "backtest": {
      const from = opt("--from");
      const to = opt("--to");
      if (from === undefined || to === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new Error("backtest --from YYYY-MM-DD --to YYYY-MM-DD");
      const s = createServices(open(), systemClock);
      const days: { date: string; analyzed: number; noOdds: number; signals: number }[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const r = await runAnalysis(s, { date: d, trigger: "BACKFILL", actor: "local-cli:backtest" });
        if (r.races.length === 0) continue;
        days.push({ date: d, analyzed: r.races.filter((x) => x.status === "ANALYZED").length, noOdds: r.races.filter((x) => x.status === "NO_ODDS").length, signals: r.races.reduce((a, x) => a + x.signals, 0) });
      }
      const perf = await performanceReport(s, from, to);
      console.log(JSON.stringify({ days, performance: perf }, null, 2));
      console.log("注意: 紙上成績（購入していない仮想の損益）。将来の成績を保証しない。");
      return;
    }
    case "push": {
      const file = rest[0];
      const url = opt("--url");
      const token = process.env["INGEST_TOKEN"];
      if (file === undefined || url === undefined || !/^https:\/\/[^/]+/.test(url)) throw new Error("push <envelopes.json> --url https://<site>");
      if (token === undefined || token.length < 32) throw new Error("環境変数 INGEST_TOKEN（32 文字以上）を設定してください");
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      const envs = (Array.isArray(raw) ? raw : [raw]).map((e) => IngestEnvelopeRequest.parse(e));
      let ok = 0;
      let dup = 0;
      for (const env of envs) {
        const res = await fetch(new URL("/api/v1/ingest/batches", url), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(env) });
        if (!res.ok) throw new Error(`送信に失敗: HTTP ${res.status}（${ok} 件送信済み。再実行すると送信済みは重複として数えるだけ）`);
        const body = (await res.json()) as { status?: unknown };
        if (body.status === "DUPLICATE_BATCH") dup++;
        else ok++;
      }
      console.log(`push: ${ok} 件を送信、${dup} 件は送信済み`);
      return;
    }
    default:
      console.log("usage: node dist/src/local/cli.js <migrate|seed-demo|import|import-csv|analyze|backtest|backup|restore|export|legacy-export|legacy-import|push>");
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
