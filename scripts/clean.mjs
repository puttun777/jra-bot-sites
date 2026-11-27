// dist/ を消す（ビルドの前に古い生成物を残さない）
import { rmSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
