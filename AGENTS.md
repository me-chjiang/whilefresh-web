# 项目协作约定

本文件是本项目 AI 编码与协作规则的唯一来源；`CLAUDE.md` 只引入本文件。

## 项目概述

- 趁鲜 WhileFresh 的 Web 版：TypeScript + Node.js + 本地 SQLite，手机浏览器访问，密钥留在服务端。
- 由 Qt / Android 版（[me-chjiang/whilefresh](https://github.com/me-chjiang/whilefresh) 的 `app/`）重写而来；行为规格以原 Qt 工程为准，代码注释中的 `app/src/...` 行号即出处。
- 已对齐 Qt main 第二轮 T13–T17、T18b，T18–T21 未开始。
- 目录与放置规则见 `FHS.md`，命令见 `docs/development.md`。

## 开发与验证

- 技术栈：Node 24、pnpm、Fastify 5、`node:sqlite`、sharp、exifr、Vite + React 19、Vitest、Playwright；TypeScript strict ESM。
- 分层依赖：`server/domain` 无 I/O；`data`、`recognition`、`import` 依赖 `domain`；`ai`、`recipes` 只依赖 `domain`，其中 `recognition` 还可以依赖 `ai`；`services` 组合以上各层；`routes` 只调用 `services`；前端只经 `client/api.ts` 访问服务端。
- 改动后至少运行 `pnpm typecheck` 与 `pnpm test`；涉及界面或流程时加跑 `pnpm e2e`。输出重定向到 `/tmp/` 下的日志文件，失败时只看末尾。
- 依赖只装在项目本地。
- 过夜流水线（`scripts/nightly.sh`）执行 `docs/codex-plan.md` 时，以该计划的全局约定与当前步骤为准；其中“功能步骤后测试可暂时失败”优先于上面的“改动后运行测试”。

## 安全与隐私

- 密钥与凭据只从环境变量和 `<dataDir>/secrets.json` 读取；DeepSeek 使用 `WHILEFRESH_DEEPSEEK_API_KEY`，Lexmount 使用 `WHILEFRESH_LEXMOUNT_API_KEY` 和 `WHILEFRESH_LEXMOUNT_PROJECT_ID`。不得打印、写日志、放进 HTTP 响应或测试快照，脚本不开启 `set -x`；`secrets.json` 不纳入 Git，文件权限为 0600。提交前用 `rg -uu -l -e 'sk-[0-9a-f]{32}' --glob '!node_modules/**' .` 确认无密钥。
- 不将 `.env`、个人数据、真实购物样例或其识别录制纳入 Git；测试只用合成数据。

## Git 约定

- 主分支 `main`；功能在独立分支开发，经审查和测试后由用户确认合并。
- 提交信息遵循 Conventional Commits；使用本机 Git 用户配置，不添加 `Co-Authored-By` 等额外署名。
- 未经明确要求，不创建提交、不推送远端、不改写提交历史。
