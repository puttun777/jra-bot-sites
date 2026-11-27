# DATA_SOURCES — データの取得元と取込形式

## 1. 方針と現状（2026-11-27）

- JV-Link・JRA-VAN Data Lab. は使わない（依頼の必須制約）。
- **公開 Web（JRA 公式サイト等）の自動取得は実装していない**。理由: この環境から JRA 公式サイト・robots.txt に到達できず（プロキシで拒否）、
  利用規約の全文を確認できなかった。検索で確認できたのは「JRA が管理するインターネットメディアの映像・音声・画像・記事等は JRA または第三者の著作物」
  （https://www.jra.go.jp/use/ の要約）までで、**自動取得・保存・再利用の可否は未確認**。netkeiba 等の民間サイトは一般にスクレイピングを禁止している。
  → 利用規約への抵触が懸念されるため独断で進めない（本人判断: HANDOFF §12 U-1）。
- 取得は優先順位の第 2・第 3 を実装済み:
  - **第 2: ChatGPT が取得して MCP ツールで登録**（`upsert_*`。`get_fetch_plan` で未取得のものだけを取得）
  - **第 3: CSV / JSON の手動取込**（画面の「データ取込」・ローカル CLI）
- 第 1（サイトから直接取得）は、規約の確認と Sites の外部通信の確認（SITES_CONSTRAINTS E-3）の後に `src/integrations/` へアダプターを足す。
  アダプターは**正規化 JSON レコードを返すだけ**にし、保存・検査は既存の取込（`ingestBatch`）を通す（取得と保存の分離）。

## 2. データ項目ごとの整理

既存の業務ロジック（判定・成績）が実際に使う項目だけを対象にした。使っていない項目（馬体重・血統・調教師など）は ML の移植（保留）まで取得しない。

| 項目 | 取込レコード | 必要な理由 | 取得元の候補 | 取得方法（現状） | 更新頻度 | 取得できない場合 |
|---|---|---|---|---|---|---|
| 開催日（場・回・日目・中止・延期） | `NYS` | 判定の対象日・鮮度 | JRA 公式の開催日程 | ChatGPT（MCP `upsert_race_days`）/ 手動 | 週 1（前週末）＋変更時 | 予定未取得 → 判定しない（UNKNOWN） |
| レース（発走時刻・レース名・版） | `NRA` | 判定の対象・発走前の判定 | JRA 公式の出馬表 | ChatGPT（`upsert_races`）/ 手動 | 前日夕方・当日朝 | 時刻不明 → 判定しない（NOT_IN_WINDOW） |
| 発走時刻の変更 | `NTC` | 時刻変更 | JRA 公式のお知らせ | ChatGPT / 手動・手動補正（画面） | 当日の変更時 | 手動補正 SET_POST_TIME |
| 単勝オッズ・人気 | `NOW` | 確率・EV の入力（必須） | JRA 公式のオッズ | ChatGPT（`upsert_odds`）/ CSV（win-odds） | 発走前（例: 30 分前・10 分前） | **分析不能（NO_ODDS）**。推測しない |
| ワイドオッズ（下限・上限） | `NOD` | ワイドの EV（実オッズ必須） | 同上 | 同上 | 同上 | ワイドは「実オッズ未取得のため見送り」 |
| 三連複オッズ | `NOS` | 三連複の EV（実オッズ必須） | 同上 | 同上 | 同上 | 三連複は見送り |
| 着順 | `NRS` | 成績 | JRA 公式のレース結果 | ChatGPT（`upsert_results`）/ CSV（results） | 結果確定後 | 成績は未確定として数えない |
| 払戻（100 円あたり） | `NHR` | 成績（的中判定は払戻の行） | JRA 公式の払戻金 | ChatGPT（`upsert_results`）/ CSV（payouts） | 結果確定後 | 同上 |

取得のコスト: 外部 API の従量課金なし。ChatGPT の利用枠を使う（`get_fetch_plan` で差分だけ。1 回の登録は最大 200 レコード）。

## 3. 正確性の規則（推測値を実データにしない）

- 取得できない値は登録しない（null・未取得のまま）。AI の推測値・架空の値を登録しない（Automations の依頼文にも明記: OPERATIONS §4）。
- `observedAt` は**実際に取得した時刻**。発走後に見た確定オッズを発走前の値として登録しない。判定は観測時刻 ≤ min(現在, 発走) のオッズだけを使う（D-S10）。
- 取込の境界で検査する（web の ObservationApplier と同じ）: オッズ 0 < x < 1 は隔離、組み合わせキーの形式・重複・範囲、着順 1〜99、払戻 > 0。
- 不正なレコードは隔離（FAILED）し、既存の正常なデータを上書き・削除しない。依存するレースが未登録なら保留（PENDING）にして到着後に再適用する。
- 速報の払戻は確定を上書きしない。古い版の予定は反映しない（版 = 作成日 + 区分）。

## 4. 取込形式（正規化 JSON。web の NormalizedJsonRecordParser と同じ）

封筒（`POST /api/v1/ingest/batches`・画面の JSON 取込・CLI `import`）:

```json
{
  "batchId": "6f1c3c2e-8a41-4d7e-9c3a-2b8a0f0d1e11",
  "source": "chatgpt",
  "observedAt": "2026-11-28T05:20:00Z",
  "records": [
    { "id": "NYS", "data": { "date": "20261128", "venue": "05", "kai": 5, "nichime": 8, "status": "PLANNED", "replacedBy": null } },
    { "id": "NRA", "data": { "raceId": "202611280511", "kubun": "2", "createdOn": "20261127", "postTime": "1540", "raceName": "ジャパンカップ", "kai": 5, "nichime": 8 } },
    { "id": "NOW", "data": { "raceId": "202611280511", "entries": [{ "umaban": 1, "odds": 3.1, "pop": 1 }] } },
    { "id": "NOD", "data": { "raceId": "202611280511", "entries": [{ "a": 1, "b": 2, "low": 3.9, "high": 5.8, "pop": null }] } },
    { "id": "NOS", "data": { "raceId": "202611280511", "entries": [{ "a": 1, "b": 2, "c": 3, "odds": 12.5, "pop": null }] } },
    { "id": "NRS", "data": { "raceId": "202611280511", "entries": [{ "umaban": 2, "finish": 1 }] } },
    { "id": "NHR", "data": { "raceId": "202611280511", "market": "wide", "provisional": false, "entries": [{ "key": "01-02", "payout": 390 }] } }
  ]
}
```

- レース ID: `YYYYMMDD` + 場コード（01 札幌〜10 小倉）+ レース番号 2 桁（web の RaceId と同じ。情報源が変わっても同じレースを同じ ID で識別する）。
- `kubun`: 1 = 出走馬名表、2 = 出馬表（発走時刻を採用）、9 = 中止、0 = 削除。`createdOn` は情報の作成日（版の比較に使う）。
- キーはすべて必須、余分なキーは不正（隔離）。1 封筒 200 レコードまで、1 レコードの entries 5000 まで。

CSV（CLI `import-csv <kind> <file> --observed-at <ISO>`）: `win-odds` = `race_id,umaban,odds,popularity` / `results` = `race_id,umaban,finish` / `payouts` = `race_id,market,key,payout`。
