# 开发文档

产品概览见 [README.md](../README.md)，目录规则见 [FHS.md](../FHS.md)。

## 环境

- Node 24（使用内置 `node:sqlite`）、pnpm。依赖装在项目本地 `node_modules/`：`pnpm install`。
- e2e 首次需下载浏览器：`pnpm exec playwright install chromium`（装到 `.cache/ms-playwright/`，已被 git 忽略）。

## 运行

| 用途 | 命令 |
| --- | --- |
| 开发（`tsx watch` 服务端 + Vite，`/api` 代理到 `127.0.0.1:5174`） | `scripts/dev.sh` |
| 构建并以生产模式启动（托管 `dist/` 与 `/assets/{fonts,textures,icons}`） | `scripts/start.sh` |

两个脚本从 macOS 钥匙串读取 `landing-project-deepseek`，导出为 `WHILEFRESH_DEEPSEEK_API_KEY`；读取失败时只提示“未配置密钥，可使用演示模式”并继续运行。环境变量相当于“内置”密钥；服务页保存的用户密钥写入数据目录下的 `secrets.json`（默认即 `data/secrets.json`，权限 0600，已被 git 忽略），接口永不回传密钥值。用户密钥优先于环境变量，演示模式只使用环境变量。不经脚本直接运行 `pnpm dev` / `pnpm start` 时需自行设置该变量，否则只能用演示模式。

添加密钥：

```sh
security add-generic-password -s landing-project-deepseek -a "$USER" -w   # 按提示输入，不要写在命令行里
```

Lexmount 密钥通过 `WHILEFRESH_LEXMOUNT_API_KEY` 和 `WHILEFRESH_LEXMOUNT_PROJECT_ID` 提供给服务。`scripts/dev.sh`、`scripts/start.sh` 默认从 `~/.config/lexmount/config.yaml` 读取这两个值。每次菜谱搜索或查看详情都会新开一个云浏览器会话，按次计费，并可能遇到滑块验证。

## 数据目录

运行数据（`whilefresh.db`、`secrets.json`、演示用 `demo.db`、`imports/` 下的导入图片）默认放在 `data/`，已被 git 忽略；用 `WHILEFRESH_DATA_DIR` 指向其他目录，例如临时体验：`WHILEFRESH_DATA_DIR=$(mktemp -d) scripts/start.sh`。

## 数据库迁移

数据库迁移 2 对应 Qt schema v5。

迁移 3 是 Web 独有的：给 `imports` 加 `stock_cleared` 标记，由 `items` 上的触发器维护。某次导入的食材全部不在库（用掉、扔掉、家里没有或被删除）后，这条记录不再参与重复导入检测；有食材回到在库状态时自动恢复。

## 监听地址与安全

服务默认只监听 `127.0.0.1:5174`。用 `WHILEFRESH_HOST=0.0.0.0` 等改为对外监听可让同一局域网的手机访问，但服务**没有任何鉴权**：同网段任何人都能读写库存、删除全部数据、改写已保存的密钥，并以你的密钥发起付费请求。此时启动日志会给出警告。只在可信网络短时开启，用完改回默认。

## 测试

| 用途 | 命令 |
| --- | --- |
| 类型检查（服务端与前端两套 tsconfig） | `pnpm typecheck` |
| 单元与集成测试（Vitest，`tests/`） | `pnpm test` |
| 单个文件 | `pnpm test -- tests/domain/freshness.test.ts` |
| 端到端（Playwright，412×915 视口，演示模式全流程） | `pnpm e2e` |

e2e 会先构建，再以 `WHILEFRESH_DATA_DIR=$(mktemp -d)` 在 5174 端口启动服务，运行前确保该端口空闲；失败截图和 trace 在 `test-results/`。新增测试目录包括 `tests/ai`、`tests/recipes`、`tests/helpers`。测试全部离线，使用本地假服务和 `test-data/recordings/` 回放，不访问付费服务。

AI 归类、偏好整理和菜谱搜索都会调用付费服务；测试不会发出这些请求。

提交前确认无密钥：`rg -uu -l -e 'sk-[0-9a-f]{32}' --glob '!node_modules/**' .` 应无输出。

## 内置数据

内置数据不再包含菜谱。`assets/data/` 下的 `vocabulary.json`、`shelf-life.json` 由原 Qt 仓库（[me-chjiang/whilefresh](https://github.com/me-chjiang/whilefresh)）`tools/` 中的 Python 工具生成，本仓库不手改；更新时从那里重新生成后复制过来，再重启服务。`assets/demo/` 是演示模式的预设识别结果，`test-data/` 是合成样本与录制，均来自同一来源。
