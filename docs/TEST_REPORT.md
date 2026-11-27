# TEST_REPORT

実行日: 2026-11-27 / 環境: Claude Code クラウドセッション（Ubuntu・Node v22.23.5・npm 10.9.9）/ DB: node:sqlite（SQLite 3.54.1）。
**Sites 上での実行はしていない**（未検証項目は §4）。

## 1. 結果

| コマンド | 結果 |
|---|---|
| `npm run typecheck` | 成功（エラー 0） |
| `npm run lint` | 成功（エラー 0・警告 0） |
| `npm run build` | 成功（tsc + 画面の束ね + Worker を platform: neutral で束ね） |
| `npm test` | **119 件すべて成功**（失敗 0・skip 0・todo 0。2026-11-27 の追加分を含む） |

内訳:

| 区分 | ファイル | 件数 | 内容 |
|---|---|---|---|
| ゴールデン（旧 Python → Kotlin → TypeScript） | `tests/golden/analysis.test.ts` | 22 | GD01〜GD10・G8（分割・重複除去・Retry-After）の 21 フィクスチャ（全呼び出し）+ 既定値。比較規則はフィクスチャの comparison_rules（abs_tol 1e-9〜0） |
| 画面（jra-bot-web からコピー） | `tests/web/*.test.ts` | 54 | API 呼出し・契約見本の検査・整形・表示・入力検査・要素 id の対応・innerHTML 不使用 |
| 統合（DB 連携） | `tests/integration/pipeline.test.ts` | 12 | マイグレーション・取込（保留→再適用・冪等・隔離・速報が確定を上書きしない）・カレンダー（古い版・中止の終端・履歴）・手動補正・判定（未来情報の不使用・重複実行防止・リース回収・停止モード）・成績（ワイドの 1-3 着の的中） |
| 統合（API） | `tests/integration/api.test.ts` | 12 | 401/403・閲覧者と所有者の分離・CSRF・疑似ログインが本番入口で無効・入力検証・SQL 注入の文字列・契約見本と同じ形・取込トークンの発行と失効・MCP（tools/list・upsert→判定→結果・不正な引数・未知のツール・取得計画） |
| 単体 | `tests/unit/compat.test.ts` | 9 | Python 互換の丸め・repr・補償加算、正しく丸めた log/exp、CSV、RaceId、JST、正規化 JSON パーサ、版の比較 |
| 統合（旧データの移行） | `tests/integration/legacy.test.ts` | 3 | 旧スキーマ（jra-bot schema.sql）の合成 DB → 変換（時刻の規則・キー・除外理由）→ 取込 → 過去日の再判定（発走後のオッズを使わない）→ ワイドの成績 → 再実行で二重に入らない |
| 統合（データ保持） | `tests/integration/retention.test.ts` | 2 | ドライラン・対象外を消さない・API の権限・日数の範囲 |
| 単体（JRA アダプター） | `tests/unit/jra.test.ts` | 5 | 自作の最小 HTML での解析（開催日・レース・時刻・着順・取消・払戻）・読めないときは空・2 秒間隔・不正な指定・HTTP エラー・封筒の組み立て |

## 2. 移植前後の比較（ゴールデン）で分かったこと
- 20/21 は最初から一致。**GD06 だけ**、EV が完全に同じ買い目の並び（安定ソートの同点）が旧実装と違った。原因は V8 の `Math.log`/`Math.exp` が glibc/numpy と最後の 1 ULP で異なること。
  double-double で正しく丸める `crLog`/`crExp` に替えて全件一致（D-S03）。この環境の Python で 2 万件を比べ、正しく丸めた値と一致することを確認（glibc・numpy 自体も数件〜5% は 1 ULP 違う）。
- 浮動小数の 1 ULP の違いは、旧実装でも実行環境（CPU・numpy の SIMD）で変わり得る。許容誤差 1e-9 の比較は全件合格。

## 3. 未対応のゴールデン（成功に数えていない）
| フィクスチャ | 理由 |
|---|---|
| G1〜G7（ML: モデル推論・ハッシュ特徴・特徴量・ensemble） | ML は保留（FEATURE_MATRIX #25）。G1・G2 は同梱済みで、移植時に使う |
| G8-SINGLE / G8-GROUPED / G8-REASON（Discord の本文） | Discord 送信は保留（E-3）。本文の整形は未移植 |
| GD11（旧の決済: winning keys・bets・race_evaluations の更新） | 旧の決済表は web でも成績に使っていない。成績は web の PerformanceReadService の規則で計算（統合試験で確認） |

## 4. 実施していない試験（Sites 上でしか確かめられない）
D1 でのマイグレーション・batch・CHECK、身元ヘッダの偽装防止、MCP の登録と認証、Automations からの呼び出し、外部通信、実行時間の上限、静的ファイルの配信（SITES_CONSTRAINTS §3 の E-1〜E-8）。
実データでの試験はしていない（利用が認められた実データが無い。試験はすべて合成データ: `source=test` / `demo-synthetic`）。

## 5. JRA 公式サイトでの取得の確認（2026-11-27。実ページ。HTML は保存していない）
- `fetch-jra --date 2026-11-28 --what card`: 3 リクエストで開催日 2 場・24 レース（発走時刻・名前）を取込（26 レコード反映）。
- `fetch-jra --date 2026-11-22 --what results --venue 05`: 14 リクエストで東京 12 レースの着順 175 件・単勝 12・ワイド 36・3 連複 12 を取込。
- オッズのページは発売前のため未確認（パーサ未実装）。

## 6. 画面の動作確認
ローカルサーバ（合成データ）を Playwright（Chromium）で開き、PC（1280px・ライト）とスマホ（390px・ダーク）で、概要（レース一覧・レース詳細）・運用（取得状況・実行履歴・手動実行・JSON 取込・手動補正・取込クライアント）・成績の表示を確認。コンソールのエラー 0。
