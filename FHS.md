# File Hierarchy Standard (FHS)

本项目目录结构与文件放置规则的权威说明。新增顶层目录、新增一类文件，或某类文件改放别处时，同步更新本文件。

## Layout

```
.
├── AGENTS.md / CLAUDE.md      # 协作规则（CLAUDE.md 只引入 AGENTS.md）
├── FHS.md                     # 本文件
├── README.md                  # 简介、技术栈、快速开始
├── LICENSE                    # BSD-3-Clause
├── package.json               # 依赖与脚本（typecheck / test / dev / build / start / e2e）
├── docs/
│   ├── codex-plan.md          # 移植计划与逐步执行约定
│   └── development.md         # 开发文档：环境、运行、数据目录、安全、测试
├── server/
│   ├── main.ts / config.ts    # Fastify 装配与配置（环境变量 WHILEFRESH_*）
│   ├── domain/                # 纯函数领域逻辑：日期、新鲜度、词表、保质期链、常备、菜谱匹配、待买、重复检测
│   ├── data/                  # node:sqlite 库与迁移、Store、内置数据加载
│   ├── ai/                    # AI 聊天客户端、提示词构建、归类与偏好整理
│   ├── recognition/           # 识别接口与实现（DeepSeek、回放、演示）、提示词、切片、解析、录制
│   ├── recipes/               # 菜谱契约、下厨房解析与 Lexmount 菜谱源
│   ├── import/                # 上传文件落盘、SHA-256、拍摄日期判定
│   ├── services/              # KitchenService、ImportService、AppState（真实 / 演示两个库）
│   └── routes/                # REST 路由与 JSON schema 校验
├── shared/                    # 前后端共用的枚举与 API 契约（DTO、路由表）
├── client/                    # Vite + React 前端
│   ├── api.ts                 # 唯一的 HTTP 访问入口
│   ├── components/            # 可复用组件
│   ├── pages/                 # 页面
│   └── styles/                # 主题 CSS 变量与手账风格样式
├── assets/
│   ├── data/                  # 内置只读数据（外部工具生成）：词表、保质期参考表
│   ├── demo/                  # 演示模式预设识别结果（<输入类型>.json，录制格式）
│   ├── fonts/                 # Noto Serif SC Black 子集与 OFL 许可
│   ├── textures/              # 可平铺纸纹与胶带纹理
│   └── icons/                 # Tabler 线条 SVG（附许可文件）
├── tests/                     # Vitest，按被测层分子目录（domain/ data/ ai/ recognition/ recipes/ services/ routes/）
│   └── helpers/               # 假 HTTP / Lexmount 服务与录制菜谱源等测试辅助
├── e2e/                       # Playwright 端到端测试（演示模式全流程）
├── test-data/                 # 合成样本、标准答案、合成样本的识别录制与测试词表
├── scripts/                   # dev.sh / start.sh：读钥匙串密钥后启动；nightly.sh：按 docs/codex-plan.md 逐步调用 Codex
├── .nightly/                  # 不进 Git：nightly.sh 的日志（logs/）与断点（checkpoint）
├── data/                      # 不进 Git：运行数据（whilefresh.db、demo.db、imports/）
└── dist/                      # 不进 Git：前端构建产物
```

## Placement rules

- `server/domain/` 只放纯函数，不做 I/O（不读文件、不访问数据库或网络），日期通过注入的 `Clock` 取得，以便直接单测。
- SQL 只出现在 `server/data/`；迁移集中在 `db.ts` 的递增列表中，只追加不改旧项。
- `server/services/` 组合领域、持久化与识别，涉及多表的写入放进事务；`server/routes/` 只做校验与映射，不写业务规则。
- `server/ai/` 只依赖 `server/domain/`，`server/recognition/` 可以依赖 `server/ai/`，`server/recipes/` 只依赖 `server/domain/`。
- 识别实现都实现 `server/recognition/types.ts` 中的 `Recognizer` 接口；提示词集中在 `prompt.ts`，改动含义时同步改 `PROMPT_VERSION`。
- 菜谱抓取脚本和选择器集中在 `server/recipes/lexmount-source.ts`。
- 前后端共用类型只放 `shared/`；前端只通过 `client/api.ts` 访问服务端，组件和页面不直接调用 `fetch`。
- 运行数据只写 `data/`（或 `WHILEFRESH_DATA_DIR` 指定的目录）。
- `assets/data/` 与 `test-data/` 为外部工具生成物，不手改。真实样例及其识别录制不得进入仓库，只用合成数据。
- 测试放 `tests/<层>/`，端到端放 `e2e/`；测试数据目录一律用临时目录。
- 一次性探针或实验脚本放 `/tmp`，不进仓库。

## Stability notes

- 新文件用 kebab-case；React 组件与页面文件按惯例用 PascalCase。
- `assets/data/` 中的文件名被 `server/data/builtin.ts` 引用，改名需同步。
- 密钥不得出现在仓库任何位置；只从环境变量 `WHILEFRESH_DEEPSEEK_API_KEY` 读取。

## Change log

- 2026-11-01 — 初版：从 whilefresh 仓库 `feat/web-rewrite` 分支的 `web/` 拆出为独立仓库，`app/assets` 改为 `assets/`，`test-data/` 随迁。
- 2026-11-01 — 对齐 Qt 第二轮 T13–T17、T18b：补充 AI、下厨房菜谱、测试辅助与移植计划的目录及分层规则。
