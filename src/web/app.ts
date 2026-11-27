/**
 * JRA Bot ダッシュボードの画面（index.html から `<script type="module" src="/js/app.js">` で読む）。読取り中心で、管理者だけが手動補正を操作できる。
 * 外部ライブラリ・CDN・インライン script なし。値は textContent だけで描画する。応答は schema.ts で検査してから使う。
 */
import { ApiError, getJson, messageOf, post, postJson } from "./api.js";
import { byId, el, emptyBox, errorBox, pill, show, table } from "./dom.js";
import { dateQuery, hasNextPage, pageInfo, performanceQuery, signalsQuery } from "./format.js";
import { type Agent, Agents, AnalysisSummary, Me, MlModels, type Override, Overrides, Performance, RaceDetail, Races, Runs, SignalPage, Status, SyncStatus } from "./schema.js";
import { integer, object, string } from "./validate.js";
import {
  AGENT_HEADERS,
  agentRows,
  analysisMessage,
  DETAIL_SIGNAL_HEADERS,
  detailSignalRows,
  ENTRY_HEADERS,
  ENTRY_NUM_COLS,
  entryRows,
  raceDetailNote,
  SYNC_HEADERS,
  syncRows,
  syncSummary,
  ML_HEADERS,
  ML_NUM_COLS,
  mlModelRows,
  OVERRIDE_HEADERS,
  overrideRequest,
  overrideRows,
  PERF_HEADERS,
  PERF_NUM_COLS,
  performanceIsEmpty,
  performanceNote,
  performanceRows,
  RACE_HEADERS,
  RUN_HEADERS,
  raceRows,
  revokeReason,
  runRows,
  SIGNAL_HEADERS,
  SIGNAL_NUM_COLS,
  signalRows,
  statusPills,
} from "./view.js";

const TABS = ["overview", "signals", "performance", "ops"] as const;
type Tab = (typeof TABS)[number];
function isTab(v: string | undefined): v is Tab {
  return TABS.some((t) => t === v);
}

const PAGE_SIZE = 50;
const STATUS_REFRESH_MS = 60_000;

function ui() {
  return {
    statusbar: byId("statusbar", HTMLDivElement),
    date: byId("date", HTMLInputElement),
    reload: byId("reload", HTMLButtonElement),
    races: byId("races", HTMLDivElement),
    signalTable: byId("signal-table", HTMLDivElement),
    pageinfo: byId("pageinfo", HTMLSpanElement),
    prev: byId("prev", HTMLButtonElement),
    next: byId("next", HTMLButtonElement),
    from: byId("from", HTMLInputElement),
    to: byId("to", HTMLInputElement),
    perf: byId("perf", HTMLDivElement),
    runs: byId("runs", HTMLDivElement),
    admin: byId("admin", HTMLDivElement),
    overrides: byId("overrides", HTMLDivElement),
    form: byId("override-form", HTMLFormElement),
    scope: byId("o-scope", HTMLSelectElement),
    action: byId("o-action", HTMLSelectElement),
    race: byId("o-race", HTMLInputElement),
    postAt: byId("o-postat", HTMLInputElement),
    postponed: byId("o-postponed", HTMLInputElement),
    reason: byId("o-reason", HTMLInputElement),
    msg: byId("o-msg", HTMLSpanElement),
    mlModels: byId("ml-models", HTMLDivElement),
    agents: byId("agents", HTMLDivElement),
    agentMsg: byId("agent-msg", HTMLSpanElement),
    raceDetail: byId("race-detail", HTMLDivElement),
    sync: byId("sync", HTMLDivElement),
    syncSummary: byId("sync-summary", HTMLParagraphElement),
    runAnalysis: byId("run-analysis", HTMLButtonElement),
    replay: byId("replay", HTMLButtonElement),
    modeNormal: byId("mode-normal", HTMLButtonElement),
    modeStop: byId("mode-stop", HTMLButtonElement),
    runMsg: byId("run-msg", HTMLSpanElement),
    importJson: byId("import-json", HTMLTextAreaElement),
    importBtn: byId("import-btn", HTMLButtonElement),
    importMsg: byId("import-msg", HTMLSpanElement),
    agentCreate: byId("agent-create", HTMLButtonElement),
  };
}
type Ui = ReturnType<typeof ui>;

function start(u: Ui): void {
  const state: { page: number; tab: Tab } = { page: 0, tab: "overview" };

  async function loadStatus(): Promise<void> {
    try {
      const s = await getJson("/api/v1/status", Status);
      u.statusbar.replaceChildren(...statusPills(s).map(pill));
      if (!u.date.value) u.date.value = s.today;
    } catch (e) {
      u.statusbar.replaceChildren(el("span", messageOf(e), "pill ng"));
    }
  }

  async function loadRaces(): Promise<void> {
    try {
      const rows = await getJson(`/api/v1/races${dateQuery(u.date.value)}`, Races);
      const cells = raceRows(rows).map((r, i) => {
        const race = rows[i];
        if (race === undefined) return r;
        const b = el("button", "詳細");
        b.type = "button";
        b.addEventListener("click", () => void loadRaceDetail(race.raceId));
        return [...r, b];
      });
      show(u.races, rows.length ? table([...RACE_HEADERS, ""], cells) : emptyBox("この日のレース予定はありません（予定が未取得の可能性があります）。"));
    } catch (e) {
      show(u.races, errorBox(messageOf(e)));
    }
  }

  async function loadRaceDetail(raceId: string): Promise<void> {
    show(u.raceDetail, emptyBox("読み込み中…"));
    try {
      const d = await getJson(`/api/v1/race-detail?raceId=${encodeURIComponent(raceId)}`, RaceDetail);
      const wrap = el("div");
      wrap.appendChild(el("p", raceDetailNote(d), "note"));
      wrap.appendChild(d.entries.length ? table(ENTRY_HEADERS, entryRows(d), ENTRY_NUM_COLS) : emptyBox("オッズ・出走の情報が未取得です。"));
      if (d.signals.length) wrap.appendChild(table(DETAIL_SIGNAL_HEADERS, detailSignalRows(d), [2, 3, 4, 5, 6]));
      show(u.raceDetail, wrap);
    } catch (e) {
      show(u.raceDetail, errorBox(messageOf(e)));
    }
  }

  async function loadSync(): Promise<void> {
    try {
      const st = await getJson("/api/v1/sync-status", SyncStatus);
      u.syncSummary.textContent = syncSummary(st);
      show(u.sync, st.races.length ? table(SYNC_HEADERS, syncRows(st)) : emptyBox("本日のレース予定は未取得です。"));
    } catch (e) {
      show(u.sync, errorBox(messageOf(e)));
    }
  }

  async function loadSignals(): Promise<void> {
    try {
      const p = await getJson(`/api/v1/signals${signalsQuery(u.date.value, state.page, PAGE_SIZE)}`, SignalPage);
      u.pageinfo.textContent = pageInfo(p);
      u.prev.disabled = p.page === 0;
      u.next.disabled = !hasNextPage(p);
      show(
        u.signalTable,
        p.items.length ? table(SIGNAL_HEADERS, signalRows(p.items), SIGNAL_NUM_COLS) : emptyBox("この日のシグナルはありません。"),
      );
    } catch (e) {
      show(u.signalTable, errorBox(messageOf(e)));
    }
  }

  async function loadPerformance(): Promise<void> {
    try {
      const p = await getJson(`/api/v1/performance${performanceQuery(u.from.value, u.to.value)}`, Performance);
      if (!u.from.value) {
        u.from.value = p.from;
        u.to.value = p.to;
      }
      const wrap = el("div");
      if (performanceIsEmpty(p)) wrap.appendChild(emptyBox("この期間に確定した成績はありません。"));
      wrap.appendChild(table(PERF_HEADERS, performanceRows(p), PERF_NUM_COLS));
      wrap.appendChild(el("p", performanceNote(p), "note"));
      show(u.perf, wrap);
    } catch (e) {
      show(u.perf, errorBox(messageOf(e)));
    }
  }

  async function loadRuns(): Promise<void> {
    try {
      const rows = await getJson(`/api/v1/runs${dateQuery(u.date.value)}`, Runs);
      show(u.runs, rows.length ? table(RUN_HEADERS, runRows(rows)) : emptyBox("この日の bot の実行記録はありません。"));
    } catch (e) {
      show(u.runs, errorBox(messageOf(e)));
    }
  }

  function revokeButton(o: Override): HTMLButtonElement | string {
    if (o.revokedAt || o.id === null) return "";
    const id = o.id;
    const b = el("button", "取消");
    b.type = "button";
    b.addEventListener("click", async () => {
      if (!confirm("この補正を取り消しますか？")) return;
      try {
        await post(`/api/v1/admin/overrides/${encodeURIComponent(String(id))}/revoke`, {});
        void loadOverrides();
      } catch (e) {
        u.msg.textContent = messageOf(e);
      }
    });
    return b;
  }

  async function loadOverrides(): Promise<void> {
    try {
      const rows = await getJson(`/api/v1/admin/overrides${dateQuery(u.date.value)}`, Overrides);
      if (!rows.length) return show(u.overrides, emptyBox("この日の手動補正はありません。"));
      const cells = overrideRows(rows).map((r, i) => {
        const o = rows[i];
        return o === undefined ? r : [...r, revokeButton(o)];
      });
      show(u.overrides, table(OVERRIDE_HEADERS, cells));
    } catch (e) {
      show(u.overrides, errorBox(messageOf(e)));
    }
  }

  async function loadMlModels(): Promise<void> {
    try {
      const rows = await getJson("/api/v1/admin/ml-models", MlModels);
      show(u.mlModels, rows.length ? table(ML_HEADERS, mlModelRows(rows), ML_NUM_COLS) : emptyBox("登録されたモデルはありません。"));
    } catch (e) {
      show(u.mlModels, errorBox(messageOf(e)));
    }
  }

  function agentRevokeButton(a: Agent): HTMLButtonElement | string {
    if (a.status !== "ACTIVE") return "";
    const b = el("button", "失効");
    b.type = "button";
    b.addEventListener("click", async () => {
      const input = prompt(`エージェント ${a.agentId} を失効します。以後このエージェントの送信は拒否されます。理由（必須・500 文字まで）:`);
      if (input === null) return; // 取消
      const reason = revokeReason(input);
      if (reason === null) {
        u.agentMsg.textContent = "理由が空、または長すぎる・制御文字を含むため失効していません。";
        return;
      }
      if (!confirm(`エージェント ${a.agentId} を失効しますか？（元に戻す操作はありません）`)) return;
      try {
        await post(`/api/v1/admin/agents/${encodeURIComponent(a.agentId)}/revoke`, { reason });
        u.agentMsg.textContent = "失効しました。";
      } catch (e) {
        u.agentMsg.textContent = messageOf(e);
      }
      void loadAgents();
    });
    return b;
  }

  async function loadAgents(): Promise<void> {
    try {
      const rows = await getJson("/api/v1/admin/agents", Agents);
      if (!rows.length) return show(u.agents, emptyBox("登録されたエージェントはありません。"));
      const cells = agentRows(rows).map((r, i) => {
        const a = rows[i];
        return a === undefined ? r : [...r, agentRevokeButton(a)];
      });
      show(u.agents, table(AGENT_HEADERS, cells));
    } catch (e) {
      show(u.agents, errorBox(messageOf(e)));
    }
  }

  async function initAdmin(): Promise<void> {
    let me: Me;
    try {
      me = await getJson("/api/v1/me", Me);
    } catch (e) {
      if (e instanceof ApiError) return; // 権限が無い・通信できない場合は管理 UI を出さない
      throw e;
    }
    if (me.role !== "ADMIN") return;
    u.admin.hidden = false;
    u.form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = overrideRequest({
        scope: u.scope.value,
        action: u.action.value,
        date: u.date.value,
        raceId: u.race.value,
        postAt: u.postAt.value,
        postponedTo: u.postponed.value,
        reason: u.reason.value,
      });
      try {
        await post("/api/v1/admin/overrides", body);
        u.msg.textContent = "追加しました。";
        u.reason.value = "";
        void loadOverrides();
      } catch (e) {
        u.msg.textContent = messageOf(e);
      }
    });
    u.runAnalysis.addEventListener("click", async () => {
      u.runMsg.textContent = "実行中…";
      u.runAnalysis.disabled = true;
      try {
        const r = await postJson("/api/v1/admin/analysis/run", u.date.value ? { date: u.date.value } : {}, AnalysisSummary);
        u.runMsg.textContent = analysisMessage(r);
        void loadRuns();
        void loadSync();
      } catch (e) {
        u.runMsg.textContent = messageOf(e);
      } finally {
        u.runAnalysis.disabled = false;
      }
    });
    u.replay.addEventListener("click", async () => {
      u.runMsg.textContent = "再適用中…";
      try {
        const r = await postJson("/api/v1/admin/ingest/replay", {}, object({ attempted: integer, resolved: integer, stillPending: integer }));
        u.runMsg.textContent = `保留 ${r.attempted} 件を再適用し、${r.resolved} 件を解消しました（残り ${r.stillPending} 件）。`;
        void loadSync();
      } catch (e) {
        u.runMsg.textContent = messageOf(e);
      }
    });
    for (const [b, mode] of [
      [u.modeNormal, "NORMAL"],
      [u.modeStop, "STOPPED"],
    ] as const) {
      b.addEventListener("click", async () => {
        const reason = prompt(`運用モードを ${mode} にします。理由（必須）:`);
        if (reason === null || reason.trim() === "") return;
        try {
          await post("/api/v1/admin/mode", { mode, reason: reason.trim() });
          u.runMsg.textContent = `運用モードを ${mode} にしました。`;
          void loadStatus();
        } catch (e) {
          u.runMsg.textContent = messageOf(e);
        }
      });
    }
    u.importBtn.addEventListener("click", async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(u.importJson.value);
      } catch {
        u.importMsg.textContent = "JSON として読めません。";
        return;
      }
      try {
        const r = await postJson("/api/v1/admin/ingest", parsed, object({ status: string, records: integer, applied: integer, deferred: integer, quarantined: integer }));
        u.importMsg.textContent = `${r.status}: ${r.records} 件中 反映 ${r.applied}・保留 ${r.deferred}・隔離 ${r.quarantined}`;
        void loadSync();
      } catch (e) {
        u.importMsg.textContent = messageOf(e);
      }
    });
    u.agentCreate.addEventListener("click", async () => {
      const agentId = prompt("取込クライアントの ID（英数字・_・-、64 文字まで）:");
      if (agentId === null || !/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) return;
      const name = prompt("名前（例: ChatGPT MCP）:");
      if (name === null || name.trim() === "") return;
      try {
        const r = await postJson("/api/v1/admin/agents", { agentId, name: name.trim(), validDays: 90 }, object({ agentId: string, token: string }));
        // トークンはこの 1 回だけ表示する（再表示はできない）
        prompt("トークン（この画面を閉じると再表示できません。Sites のシークレット等に保存してください）:", r.token);
        void loadAgents();
      } catch (e) {
        u.agentMsg.textContent = messageOf(e);
      }
    });
    void loadOverrides();
    void loadMlModels();
    void loadAgents();
  }

  const loaders: Readonly<Record<Tab, () => void>> = {
    overview: () => void loadRaces(),
    signals: () => void loadSignals(),
    performance: () => void loadPerformance(),
    ops: () => {
      void loadSync();
      void loadRuns();
      if (!u.admin.hidden) {
        void loadOverrides();
        void loadMlModels();
        void loadAgents();
      }
    },
  };

  function select(tab: Tab): void {
    state.tab = tab;
    for (const b of document.querySelectorAll<HTMLElement>("nav [data-tab]"))
      b.setAttribute("aria-selected", String(b.dataset["tab"] === tab));
    for (const s of document.querySelectorAll<HTMLElement>(".tab")) s.hidden = s.id !== tab;
    loaders[tab]();
  }

  for (const b of document.querySelectorAll<HTMLElement>("nav [data-tab]")) {
    const tab = b.dataset["tab"];
    if (isTab(tab)) b.addEventListener("click", () => select(tab));
  }
  u.reload.addEventListener("click", () => {
    void loadStatus();
    loaders[state.tab]();
  });
  u.date.addEventListener("change", () => {
    state.page = 0;
    loaders[state.tab]();
  });
  u.from.addEventListener("change", () => void loadPerformance());
  u.to.addEventListener("change", () => void loadPerformance());
  u.prev.addEventListener("click", () => {
    state.page = Math.max(0, state.page - 1);
    void loadSignals();
  });
  u.next.addEventListener("click", () => {
    state.page += 1;
    void loadSignals();
  });
  void loadStatus().then(() => {
    loaders.overview();
    // 想定外の例外でも管理 UI は出さない（未処理の Promise の拒否にしない。レビュー 低）
    initAdmin().catch(() => {
      u.admin.hidden = true;
    });
  });
  setInterval(() => {
    if (document.visibilityState === "visible") void loadStatus();
  }, STATUS_REFRESH_MS);
}

function main(): void {
  try {
    start(ui());
  } catch (e) {
    // 画面の要素が欠けている（index.html と食い違い）。描画できないので状態欄に理由を出す
    const bar = document.getElementById("statusbar");
    if (bar) bar.textContent = e instanceof Error ? e.message : "画面を初期化できません。";
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
else main();
