# jra-bot-sites

jra-bot（中央競馬のオッズから期待値が正の買い目を見つける、私的・非営利の Bot）を **ChatGPT Sites** で動かす後継版。
業務仕様と画面は [jra-bot-web](https://github.com/puttun777/jra-bot-web)（Kotlin）を TypeScript に移したもので、判定の計算は旧実装と同じ結果になることを試験で確認している。

- 判定（EV・Kelly・単勝/ワイド/三連複の買い目・見送り）はプログラムで行う（生成 AI を使わない）
- データは ChatGPT（MCP ツール）か CSV/JSON の手動取込で登録（JV-Link は使わない）
- Sites 上での動作は**未検証**（[docs/SITES_CONSTRAINTS.md](docs/SITES_CONSTRAINTS.md)）

## 使い方（ローカル）

```bash
npm ci --ignore-scripts
npm test                                  # build + 試験 109 件
node dist/src/local/cli.js seed-demo      # 合成データ（実データではない）
npm start                                 # http://127.0.0.1:8787/
```

## 資料
| 資料 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 開発ルール（ChatGPT / Claude Code 共通） |
| [docs/HANDOFF.md](docs/HANDOFF.md)・[docs/CHATGPT_DEPLOY_PROMPT.md](docs/CHATGPT_DEPLOY_PROMPT.md) | Sites への引き継ぎ・依頼文 |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 進捗 |
| [docs/CURRENT_SYSTEM.md](docs/CURRENT_SYSTEM.md)・[FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md)・[MIGRATION.md](docs/MIGRATION.md) | 既存システム・機能の分類・移行の対応と判断 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)・[DATABASE.md](docs/DATABASE.md)・[DATA_SOURCES.md](docs/DATA_SOURCES.md)・[REQUIREMENTS.md](docs/REQUIREMENTS.md) | 設計 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md)・[TEST_REPORT.md](docs/TEST_REPORT.md) | 運用・試験結果 |

## 注意・免責
本ソフトウェアの出力は馬券の購入や利益を推奨・保証するものではありません。JRA・JRA-VAN 等の公式ツールではありません。
ライセンス: [MIT](LICENSE)（jra-bot と同じ。出典は docs/MIGRATION.md §1）。
