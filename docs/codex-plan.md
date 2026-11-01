# codex-plan：whilefresh-web 移植第二轮（T13–T17、T18b）

> 本文件由 `scripts/nightly.sh` 逐步交给 Codex 执行（日志与断点在被忽略的 `.nightly/`）。每一步由一次独立的 `codex exec` 完成。Codex 不记得之前的步骤，所以每一步都只依赖本文件和仓库的当前状态。

## 全局约定（每一步都适用，必须严格遵守）

**名词与命令简写**
- **仓库**：`/Users/chj/claude-projects/whilefresh-web`，所有命令都在仓库根目录执行。
- **Q**：Qt 工程 `/Users/chj/claude-projects/whilefresh`，相对仓库的路径是 `../whilefresh`。它是行为规格的唯一来源，**只读**。
  - 读文件一律用 `git -C ../whilefresh show main:<路径>`。
  - 列目录用 `git -C ../whilefresh ls-tree -r --name-only main -- <目录>`。
  - 文中写作 `Q:<路径>`，例如 `Q:app/src/ai/chat-types.cpp`。
- **TC** = `pnpm typecheck > /tmp/wfw-tc.log 2>&1 || { tail -40 /tmp/wfw-tc.log; false; }`
- **T &lt;文件…&gt;** = `pnpm test -- <文件…> > /tmp/wfw-test.log 2>&1 || { tail -60 /tmp/wfw-test.log; false; }`
- **B** = `pnpm build > /tmp/wfw-build.log 2>&1 || { tail -30 /tmp/wfw-build.log; false; }`
- **E2E** = `! lsof -iTCP:5174 -sTCP:LISTEN >/dev/null && { pnpm e2e > /tmp/wfw-e2e.log 2>&1 || { tail -40 /tmp/wfw-e2e.log; false; }; }`

**目录对应关系（Qt → Web）**

| Qt | Web |
| --- | --- |
| `Q:app/src/core/` | `server/domain/` |
| `Q:app/src/data/` | `server/data/` |
| `Q:app/src/recognition/` | `server/recognition/` |
| `Q:app/src/ai/` | `server/ai/`（新建） |
| `Q:app/src/recipes/` | `server/recipes/`（新建） |
| `Q:app/src/ui/*-service.*` | `server/services/` |
| `Q:app/src/ui/app-model.*`、`settings-model.*` | `server/services/app-state.ts`、`server/services/settings-service.ts`，加上 `server/routes/` 和 `shared/api.ts` |
| `Q:app/qml/pages/`、`Q:app/qml/components/` | `client/pages/`、`client/components/` |
| `Q:app/tests/<层>/` | `tests/<层>/` |

**执行规则**
1. 只做本步骤列出的事：
   - 不提前做后续步骤。
   - 不重构无关代码。
   - 不顺手修复本步骤以外的问题。发现了就在回复里写出来。
2. 动手前先读本步骤列出的“出处”。
   - 中文界面文案、错误提示、提示词、常量、超时和上限一律**逐字照抄**出处。
   - 出处与本文件描述冲突时，以出处为准，并在回复里写明冲突在哪里。
3. 禁止的操作：
   - 修改 `../whilefresh`。
   - 读取任何 `private/` 目录。
   - 调用真实的 DeepSeek 或 Lexmount（都要付费）。测试只能用本地假服务和仓库里的录制文件。
4. 不新增依赖。步骤里明确写了 `pnpm add` 的除外，而且只加写明的那几个包。
5. **功能步骤**（标题以“测试”开头的以外的步骤）：
   - 验证只要求 TC（以及步骤里另外列出的命令）。
   - `tsconfig.json` 也覆盖 `tests/`。如果改了签名导致 `tests/` 编译失败，只允许做让它重新编译通过的**最小机械改动**：改调用参数、改 import、给新增的必填字段补值。不准改断言，不准加或删用例。
   - 功能步骤做完后 `pnpm test` 暂时失败属于预期，由后面的测试步骤处理。
6. **测试步骤**：
   - 只改 `tests/`、`e2e/`、测试夹具和测试辅助代码，不改 `server/`、`client/`、`shared/`。
   - 如果测试暴露出产品代码的缺陷，就输出 `STEP_RESULT: FAIL`，写清楚是哪个用例、预期是什么、实际是什么、对应的出处在哪里。
   - 不准为了让测试通过而放宽断言、删除用例、`skip` 或 `todo`。
7. 代码风格：
   - TypeScript strict，ESM 模块。
   - 相对路径 import 以 `.js` 结尾，与现有代码一致。
   - 不用 `any`。
   - 只在需要解释不明显的“为什么”时写注释。
   - 新文件名用 kebab-case；React 组件和页面文件用 PascalCase。
8. 分层规则：
   - `server/domain` 是纯函数，不做 I/O，日期通过注入的 `Clock` 取得。
   - SQL 只写在 `server/data/`。
   - `server/ai` 只依赖 `domain`；`server/recognition` 可以依赖 `ai`；`server/recipes` 只依赖 `domain`。
   - `server/services` 负责组合各层；`server/routes` 只负责校验参数和调用 services。
   - 前端只通过 `client/api.ts` 访问服务端，界面上一律用 React 渲染，不用 `innerHTML`。
9. 数据库：
   - 现有 migration 1 对应 Qt schema v4，**不准修改**。
   - 第二轮只新增 migration 2，对应 Qt schema v5。
   - 时间戳沿用 store 现有的 UTC 毫秒 ISO 格式工具函数。
10. 发给 AI 的请求体要能与 Qt 字节一致：
    - 对象的键按字母序**递归**排序，然后用 `JSON.stringify` 输出，不加缩进。这对应 Qt 的 `QJsonDocument::Compact`。
    - `requestDigest` 是请求体 UTF-8 字节的 SHA-256 小写十六进制。
11. 密钥：
    - 只从环境变量和 `<dataDir>/secrets.json` 读取。
    - 不打印，不写日志，不出现在 HTTP 响应里，不写进测试快照。
    - 测试里只用 `test-key` 这类明显是假值的密钥。
12. 不要执行 `git commit`。只有最后一步按它自己的要求提交，其余步骤由外部脚本提交。

## 0. 创建分支并同步 Qt 侧数据文件
- 文件：
  - `assets/data/vocabulary.json`
  - `test-data/vocabulary/resolve-cases.json`
  - `test-data/vocabulary/synthetic-vocabulary.json`
  - `test-data/recordings/classifier/synthetic-names.json`
  - `test-data/recordings/preferences/synthetic-preferences.json`
  - `test-data/recipes/xiachufang/` 下的全部文件
- 操作：
  1. 执行 `git switch -c feat/round-2`。如果分支已存在，改用 `git switch feat/round-2`。
  2. 对上面每个路径执行 `git -C ../whilefresh show main:<Q 路径> > <本仓库路径>`，需要时先 `mkdir -p`。对应关系：
     - `assets/data/vocabulary.json` 取自 `Q:app/assets/data/vocabulary.json`。
     - 其余文件取自 Q 中同名的 `test-data/...` 路径。
     - `test-data/recipes/xiachufang/` 的文件清单用 `git -C ../whilefresh ls-tree -r --name-only main -- test-data/recipes/xiachufang` 列出，逐个复制。
  3. 本步骤不删除 `assets/data/recipes.json`，它在步骤 57 删除。
- 验证：
  - `git branch --show-current` 输出 `feat/round-2`。
  - `node -e "const v=require('./assets/data/vocabulary.json');console.log(v.items.length)"` 输出 `581`。
  - `ls test-data/recipes/xiachufang/*.yaml | wc -l` 输出 `7`。
  - TC。

## 1. ai：对话类型、请求编码与错误类型
- 文件：`server/ai/chat-types.ts`（新建）、`server/recognition/types.ts`。
- 出处：`Q:app/src/ai/chat-types.h`、`Q:app/src/ai/chat-types.cpp`。
- 操作：
  - 把 `ErrorKind` 和各错误的固定中文提示从 `server/recognition/types.ts` 移到 `chat-types.ts`。`recognition/types.ts` 改为 `export { ... } from "../ai/chat-types.js"` 再导出，保证现有调用方不用改。
  - 新增 `DEFAULT_CHAT_MODEL = "deepseek-flash"`。
  - 定义以下类型：
    - `ChatMessage`：role 加若干 part；part 是文本或 image_url。
    - `ChatRequest`：messages、jsonMode、maxTokens、temperature、thinking（默认 true）、idleTimeoutMs?、deadlineMs?。两个超时字段不进请求体。
    - `ChatResult`：content、finishReason、truncated、usage、elapsedMs、rawBody。
    - `ChatError`：kind、detail、httpStatus?。
    - `ChatRequestSummary`。
  - 实现 `encodeChatRequest(req)`，返回 `{ body: string, summary }`：
    - 字段和取值与 Qt `ChatRequest::toJson` 一致。只有一个文本 part 的消息序列化成字符串，其他情况序列化成 part 数组。
    - 按全局约定 10 递归排序键。
  - 实现 `requestDigest(body)`、`parseChatResponse(rawBody)`、`parseJsonContent(text)`：
    - `parseJsonContent` 先 trim，去掉开头的 ``` 行和结尾的 ```，结果必须是 JSON 对象。
    - 解析失败一律返回 BadResponse，detail 文本照抄出处。
- 验证：TC。

## 2. ai：凭据提供者与 system prompt 构建
- 文件：`server/ai/credentials.ts`、`server/ai/system-prompt-builder.ts`（都是新建）。
- 出处：`Q:app/src/ai/api-keys.h`、`Q:app/src/ai/api-keys.cpp`、`Q:app/src/ai/system-prompt-builder.h`、`Q:app/src/ai/system-prompt-builder.cpp`。
- 操作：
  - `credentials.ts`：
    - `Service` 取值为 `"deepseek" | "lexmount" | "lexmountProjectId"`。
    - `CredentialProvider` 接口提供 `key(service): string` 和 `isConfigured(): boolean`。
    - 实现 `StaticCredentialProvider`。
    - 实现 `LayeredCredentialProvider(primary, fallback)`：primary 返回非空就用它，否则用 fallback。
    - 实现 `EnvCredentialProvider(env = process.env)`，依次读取 `WHILEFRESH_DEEPSEEK_API_KEY`、`WHILEFRESH_LEXMOUNT_API_KEY`、`WHILEFRESH_LEXMOUNT_PROJECT_ID`，都要 trim。
  - `system-prompt-builder.ts`：
    - `buildSystemPrompt(base, sections: {title, body}[], preferenceSummary?)` 的输出依次是：base、每段 `【标题】\n正文`、最后是 `【用户偏好】\n摘要`。各部分之间用 `\n\n` 连接。
    - 空段或只有空白的段跳过；正文先 trim。
  - `server/config.ts` 已经读取 `WHILEFRESH_DEEPSEEK_API_KEY`，本步骤**不要**修改它。
- 验证：TC。

## 3. ai：ChatClient 接口与 DeepSeek 实现
- 文件：
  - `server/ai/chat-client.ts`（新建）
  - `server/ai/deepseek-chat-client.ts`（新建）
  - `server/recognition/deepseek.ts`（只移出传输层代码，保留再导出）
- 出处：
  - `Q:app/src/ai/chat-client.h`
  - `Q:app/src/ai/deepseek-chat-client.h`
  - `Q:app/src/ai/deepseek-chat-client.cpp`
  - 现有的 `server/recognition/deepseek.ts`
- 操作：
  - `chat-client.ts`：
    - 定义接口 `ChatClient { send(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult>; isConfigured(): boolean }`。
    - 失败时 reject 一个 `ChatClientError`，带 `ChatError` 字段。
    - 取消时 reject 名为 `AbortError` 的错误。
    - 导出 `isAbortError(e)`。
  - `deepseek-chat-client.ts`：
    - 构造参数是 `{ credentials: CredentialProvider, baseUrl?, idleTimeoutMs?, deadlineMs?, retryDelayMs?, fetch? }`。
    - 默认值：baseUrl 为 `https://api.deepseek.com`，idleTimeoutMs 为 150000，deadlineMs 为 240000，retryDelayMs 为 1000。
    - 实现 `setCredentials(provider)`。
    - 行为照抄出处：
      - 每次 `send` 时读取 key。没有 key 时不发请求，异步 reject NotConfigured。
      - 请求头是 `Authorization: Bearer <key>`，路径是 `POST /chat/completions`，请求体用 `encodeChatRequest`。
      - **每次调用只有一个截止计时器**，并且覆盖重试和重试前的等待。空闲超时按每次尝试单独计算。请求里的 `idleTimeoutMs`、`deadlineMs` 可以覆盖默认值。
      - 只有 5xx，或者状态码小于 400 时连接被对端关闭，才重试，最多 1 次。超时、截止和 4xx 都不重试。
      - HTTP 状态码映射：401/403 是 auth-failed，402/429 是 quota，≥500 是 server-error，其他是 request-rejected。detail 写成 `HTTP <状态码>: <响应体前 200 字>`。
      - finish_reason 为 `length` 时算成功，同时 `truncated=true`。
      - 等待重试期间收到取消，就不再重试。
      - 日志只记录尺寸、计数、状态码和用量。
  - `kindForHttpStatus`、`kindForNetworkError` 移到 `deepseek-chat-client.ts`，`server/recognition/deepseek.ts` 继续再导出它们。`DeepSeekRecognizer` 本步骤**暂不修改**。
- 验证：TC。

## 4. recognition：DeepSeekRecognizer 改用 ChatClient
- 文件：`server/recognition/deepseek.ts`，以及装配识别器的位置（`server/main.ts` 和 `server/services/app-state.ts`，用 `rg -n "DeepSeekRecognizer" server` 查找）。
- 出处：`Q:app/src/recognition/deepseek-recognizer.h`、`Q:app/src/recognition/deepseek-recognizer.cpp`。
- 操作：
  - `DeepSeekRecognizer` 的构造参数改为接收一个 `ChatClient`，删掉它自己的网络、超时和重试代码。
  - 各批次仍然依次发送；错误保留原来的 kind；截断时仍返回部分结果。
  - 装配处创建**一个** `DeepSeekChatClient({ credentials: new EnvCredentialProvider() })`，由识别器共用。
  - `isConfigured` 改为委托给 ChatClient。
- 验证：TC。

## 5. ai：录制格式 2 与录制回放客户端
- 文件：`server/ai/chat-recording.ts`、`server/ai/recorded-chat-client.ts`（都是新建）。
- 出处：
  - `Q:app/src/ai/chat-recording.h`、`Q:app/src/ai/chat-recording.cpp`
  - `Q:app/src/ai/recorded-chat-client.h`、`Q:app/src/ai/recorded-chat-client.cpp`
- 操作：
  - `chat-recording.ts`：
    - 读写 format 2：`{format:2, exchanges:[{request:{digest,model,messages,images,textChars,jsonMode,maxTokens}, elapsedMs, response|error}]}`。
    - 兼容读取 format 1：`responses[]`，以及可选的 `requestDigests[]`。
    - 写文件时权限为 0600。
    - 文件不可用时抛出带中文说明的错误。
  - `RecordedChatClient`：
    - 第 n 个被应答的请求取第 n 条 exchange。
    - exchange 的 digest 非空且与请求不同时，reject BadResponse，detail 照抄 Qt（含 “re-record”）。
    - 录制用完时 reject BadResponse。
    - 录制里的 `error` 原样作为失败回放。
    - 被取消的请求不消耗 exchange。
    - 结果通过 `setImmediate` 异步返回。
    - `isConfigured()` 恒为 true。
    - 暴露 `requests()` 和 `remaining()`。
  - `RecordingChatClient(inner)` 装饰器：记录每个请求的 rawBody 或错误，以及耗时；被取消的请求不记录。提供 `toRecording()`。
  - 现有的 `server/recognition/recording.ts` 和 `replay.ts` **不修改**。
- 验证：TC。

## 6. ai：词表外名称的 AI 归类器
- 文件：`server/ai/ingredient-classifier.ts`（新建）。
- 出处：`Q:app/src/ai/ingredient-classifier.h`、`Q:app/src/ai/ingredient-classifier.cpp`（`:15-102`）。
- 操作：
  - 常量：`CLASSIFIER_MAX_NAMES = 80`，idle 30000，deadline 60000。
  - `namesToSend(names)`：先把连续空白压成一个空格并去掉首尾空白（等同 Qt 的 `simplified()`），再截取前 60 个字符；去掉空串和重复项，最多保留 80 个。
  - `buildClassifierRequest(names, catalog)`：
    - system 消息是出处中的提示词原文，加上 `【标准食材词表】` 一段，内容为 `catalog.hierarchyText()`。`hierarchyText` 在步骤 7 实现；本步骤先按签名调用，必要时在 `Catalog` 上声明一个抛出“未实现”的占位方法，由步骤 7 替换。
    - user 消息为 `<商品名>\n1. a\n2. b\n</商品名>`。
    - 请求参数：jsonMode true，thinking false，temperature 0，`maxTokens = clamp(40*n+200, 256, 4096)`，再加上上面两个超时。
  - `parseClassifierAnswer(content, sentNames, catalog)`：
    - 以 `index` 为主键（从 1 开始）。`raw_name` 与按 index 找到的名称不一致时，只有当它是已发送的名称之一才采用，否则跳过。
    - 回答是 `none`、空或 `未归类` 的跳过。
    - 回答经 `catalog.resolve` 后必须非空，否则 `rejected` 加 1。别名统一归一为标准名。
    - 同一个原名以第一个回答为准。
    - 返回 `{canonical: Map<raw, canonical>, rejected, usage, elapsedMs}`。
  - `IngredientClassifier(client)` 提供 `classify(names, catalog, signal)`。JSON 解析失败时 reject BadResponse。
- 验证：TC。

## 7. domain：Catalog 增加 resolveFinest 与 hierarchyText
- 文件：`server/domain/catalog.ts`。
- 出处：`Q:app/src/core/catalog.h`（`:42-70`）、`Q:app/src/core/catalog.cpp`。
- 操作：
  - `resolveFinest(title)`：
    1. 先 trim。如果 `resolve` 能精确命中，直接返回。
    2. 用正则 `[\s\p{P}\p{S}]+|\d+(\.\d+)?[A-Za-z]*`（带 `u` 标志）把标题切成若干 token。
    3. 在每个 token 里用 `lastIndexOf` 查找每个词条的标准名，以及**归它所有**的别名。“归它所有”指：该别名不是其他词条的标准名，且别名映射到的正是这个词条。单字只有在 token 末尾时才算命中。
    4. 收集所有候选的祖先，把祖先从候选里去掉。
    5. 同一个 token 内，取结束位置最靠后的候选；结束位置相同时取更长的。
    6. 不同 token 之间取最长的；长度相同时取靠前的 token（遍历时用严格大于比较）。
    7. 都没有命中时返回空串。
  - `hierarchyText()`：
    - 按分类的声明顺序，每个分类输出一块，块头是 `【显示名】`。分类 code 为空的显示为“其他”，空块不输出。
    - 块内先输出每个有子项的父项，格式 `父 > 子1、子2`；更深一层的后代也归到它最上层的祖先下。然后输出一行独立词条，用 `、` 连接。
    - 父项不在词表中的，该词条按独立词条处理。
    - 各行之间用 `\n` 连接。
  - 如果步骤 6 留下了占位方法，用正式实现替换它。
- 验证：TC。另执行 `pnpm exec tsx -e "import('./server/data/builtin.ts').then(m=>{const c=m.loadBuiltin().catalog;console.log(c.resolveFinest('黑猪梅花肉切片 300g'))})"`，输出 `梅花肉`。

## 8. domain：名称解析器与名称映射接口
- 文件：`server/domain/vocabulary-resolver.ts`（新建）。
- 出处：
  - `Q:app/src/core/vocabulary-resolver.h`、`Q:app/src/core/vocabulary-resolver.cpp`（`:33-53`）
  - `Q:app/src/core/name-mapping.h`
- 操作：
  - `NameSource` 取值：`unresolved | user-mapping | recognized | local-match | ai-classified | user-edited`。
  - `NameMappingStore` 接口：`mapped(raw)`、`remember(raw, canonical): boolean`、`entries(): [key, canonical][]`（按 key 排序）、`forget(raw)`、`clear()`。
  - `nameKey(raw)` 等同 Qt 的 `simplified()`：连续空白压成一个空格并去掉首尾空白。
  - 实现 `MemoryNameMappingStore`。key 或 canonical 为空时，`remember` 返回 false。
  - `resolveName(raw, suggested, catalog, mappings?)` 按以下顺序判断，返回 `{canonical, source}`：
    1. 映射命中，且映射的名称仍在词表中，返回 user-mapping。
    2. 计算 `finest = catalog.resolveFinest(raw)` 和 `model = catalog.resolve(suggested)`。
    3. model 非空时，判断“finest 更细”。条件是：finest 非空、与 model 不同，并且满足以下任一项：
       - `satisfies(finest, model)`；
       - 两者分类相同，且 model 有子项。

       更细则取 finest，否则取 model。来源记为 recognized。
    4. 否则，finest 非空时返回 local-match。
    5. 否则返回 unresolved，canonical 为空串。
  - `unresolvedNames(raws, resolutions)`：返回 source 为 unresolved 的原名，按 `nameKey` 去重，跳过空名。
- 验证：TC。

## 9. recognition：提示词 v3、分层词表与解析器调整
- 文件：`server/recognition/prompt.ts`、`server/recognition/request-builder.ts`、`server/recognition/response-parser.ts`。
- 出处：
  - `Q:app/src/recognition/prompt-templates.h`
  - `Q:app/src/recognition/request-builder.cpp`
  - `Q:app/src/recognition/response-parser.cpp`
- 操作：
  - `PROMPT_VERSION` 改为 `"v3"`。提示词全文逐字替换为出处内容，包括 raw_name、canonical_name 的说明、规则 6 的“词表分层”段，以及词表标题行。
  - `{{VOCABULARY}}` 的内容改为 `catalog.hierarchyText()`。
  - 响应解析器的 canonicalName 只用 `catalog.resolve(模型给的名称)` 得到，结果为空时写 `未归类`。删掉按原文 raw_name 细化名称的逻辑（如果有的话）；细化改由步骤 11 中的解析器负责。
- 验证：TC。

## 10. data：迁移 2（对应 Qt v5）与名称映射存储
- 文件：`server/data/db.ts`、`server/data/store.ts`。
- 出处：
  - `Q:app/src/data/database.cpp`（`:144-190`）
  - `Q:app/src/data/name-mappings.h`、`Q:app/src/data/name-mappings.cpp`
  - `Q:app/src/data/store.cpp` 中的 `deleteAllData`
- 操作：
  - 在 `db.ts` 的迁移列表末尾追加 migration 2，逐字照抄 Qt migration 5 的 DDL：
    - items 增加 4 列，imports 增加 3 列。
    - 新增 5 张表：name_mappings、preferences、import_jobs、import_job_batches、cleanup_sessions。
    - 不加索引，也不加 CHECK 约束。
  - `store.ts` 新增 `SqliteNameMappingStore`（实现步骤 8 的接口）或等价的方法组：
    - `remember` 按 raw_name upsert，同时更新 canonical_name 和 confirmed_at。
    - `entries` 按 raw_name 排序。
  - `deleteAllData` 额外清空 name_mappings、preferences、import_job_batches、import_jobs、cleanup_sessions 五张表。
- 验证：TC。另执行 `pnpm exec tsx -e "import('./server/data/db.ts').then(m=>{const d=m.openDatabase(':memory:');console.log(d.prepare(\"select count(*) n from sqlite_master where type='table' and name not like 'sqlite_%'\").get().n, d.prepare('pragma user_version').get().user_version)})"`，输出 `17 2`。

## 11. services：导入草稿接入名称解析与 AI 归类
- 文件：`server/services/import-service.ts`、`server/services/app-state.ts`、`shared/api.ts`。
- 出处：
  - `Q:app/src/ui/import-service.h`
  - `Q:app/src/ui/import-service.cpp`（`:352-410` buildDraft、classified、classificationFailed；`:496-498` updateItem；`:621-633` rememberNames）
  - `Q:app/src/ui/app-model.cpp`（`:700` aiClassified，以及 openSession 中只给真实会话装配 names/classifier 的部分）
- 操作：
  - 草稿项增加 `nameSource`。
  - 生成草稿时，对每个不是 Irrelevant 的项调用 `resolveName(rawName, 识别给出的 canonicalName, catalog, mappings)`。
  - 仍有未解析的名称，并且注入了 classifier、它也已配置时，先 `await classify`（用导入流程的 AbortSignal），再完成草稿：
    - 仍处于 unresolved 的项，如果归类结果在词表里，就写入 canonical，来源记为 ai-classified。
    - 归类失败（取消除外）时只写日志，名称保留 `未归类`，导入本身不算失败。
  - `updateDraft` 改动了 canonical 名称时，来源设为 user-edited，同时重置 aiDays 和 referenceConditionsConfirmed（字段名以现有代码为准）。
  - `confirm` 的事务提交之后，对满足以下全部条件的草稿项调用 `mappings.remember(rawName, canonical)`：
    - 已选中；
    - 不是 Irrelevant；
    - canonical 在词表中；
    - 来源是 ai-classified 或 user-edited。
  - `app-state.ts`：真实会话注入 `SqliteNameMappingStore` 和 `new IngredientClassifier(共享的 ChatClient)`；演示会话两者都不注入。
  - `shared/api.ts` 的 `DraftItemDto` 增加 `aiClassified: boolean`，并在映射处赋值。
- 验证：TC。

## 12. client：草稿页显示“AI 归类”
- 文件：`client/pages/ImportFlowPage.tsx`。
- 出处：`Q:app/qml/pages/ImportFlowPage.qml`（查找 `aiClassified`）。
- 操作：`aiClassified` 为 true 的草稿项，在名称旁显示文字标签“AI 归类”，样式沿用现有的小标签样式。
- 验证：TC && B。

## 13. 测试：ai 类型、凭据与 system prompt
- 文件：`tests/ai/chat-types.test.ts`、`tests/ai/credentials.test.ts`、`tests/ai/system-prompt-builder.test.ts`。
- 出处：`Q:app/tests/ai/chat-types-test.cpp`、`Q:app/tests/ai/system-prompt-builder-test.cpp`、`Q:app/tests/ui/settings-model-test.cpp`（其中 layered provider 的用例）。
- 操作：逐条移植以下用例：
  - 请求体的格式（键已排序；单个文本 part 序列化成字符串；两个超时字段不出现在请求体里）。
  - `parseJsonContent` 去代码围栏，以及各种坏输入。
  - `parseChatResponse` 的各种响应体。
  - Layered 优先使用 primary；Env 读取 3 个变量。
  - system prompt 的段落顺序、偏好摘要放最后、空段被丢弃。
- 验证：T tests/ai/chat-types.test.ts tests/ai/credentials.test.ts tests/ai/system-prompt-builder.test.ts。

## 14. 测试：DeepSeek ChatClient（本地假 HTTP 服务）
- 文件：`tests/ai/deepseek-chat-client.test.ts`、`tests/helpers/fake-http-server.ts`（新建）、`tests/recognition/deepseek.test.ts`。
- 出处：`Q:app/tests/ai/deepseek-chat-client-test.cpp`、`Q:app/tests/ai/fake-http-server.h`。
- 操作：
  - 把 `tests/recognition/deepseek.test.ts` 里的假服务抽到 `tests/helpers/fake-http-server.ts`，两个测试文件共用。
  - 逐条移植出处的全部用例，包括：
    - key 出现在请求头；图片以 data URL 发送，并且不进日志。
    - 状态码映射表。
    - 4xx 不重试；5xx 一次后成功；连接断开重试一次；空闲超时不重试。
    - 截止时间覆盖重试，以及重试前的等待。
    - 每次调用有各自的截止时间；请求可以覆盖时限。
    - 截断时得到部分结果；坏响应返回 BadResponse 且不重试。
    - 重试等待期间取消就停止；取消后静默，客户端仍可继续使用。
    - 服务不可达返回 NoNetwork；TLS 错误不算 NoNetwork。
    - 没有 key 时不发请求；key 在发送时才读取。
  - 时限参数调小注入。
  - `tests/recognition/deepseek.test.ts` 改为通过 ChatClient 构造识别器，原有的识别层用例保留，断言不变。
- 验证：T tests/ai/deepseek-chat-client.test.ts tests/recognition/deepseek.test.ts。

## 15. 测试：录制回放与 AI 归类器
- 文件：`tests/ai/chat-recording.test.ts`、`tests/ai/ingredient-classifier.test.ts`。
- 出处：`Q:app/tests/ai/chat-recording-test.cpp`、`Q:app/tests/ai/ingredient-classifier-test.cpp`。
- 操作：
  - 录制部分，逐条移植：
    - 按顺序回放；digest 只匹配同一个请求。
    - 截断仍是部分成功；取消不消耗录制。
    - 录制、写出、读回、回放的往返；被取消的请求不进录制。
    - 读取 format 1（包括 digests）；拒绝不可用的文件；写出的文件权限为 0600。
  - 归类器部分，逐条移植：
    - 只发文本的短 JSON 请求；最多 80 个名称。
    - 回答经词表校验（rejected、none、别名归一、index 与 raw_name 的规则）；坏回答失败；取消静默。
    - **回放录制**：用 `test-data/recordings/classifier/synthetic-names.json`，词表用出处测试里指定的那一份，回放时校验 digest。期望 冰鲜鸡全腿→鸡腿、鲜毛肚→牛肚，其余 7 个不归类。
  - digest 对不上时输出 `STEP_RESULT: FAIL`，附上本地 digest 和录制里的 digest。**不准**关闭 digest 校验，也不准重新录制。
- 验证：T tests/ai/chat-recording.test.ts tests/ai/ingredient-classifier.test.ts。

## 16. 测试：resolveFinest、hierarchyText 与名称解析器
- 文件：`tests/domain/catalog.test.ts`（新建）、`tests/domain/vocabulary-resolver.test.ts`（新建）。
- 出处：`Q:app/tests/core/catalog-test.cpp`、`Q:app/tests/core/vocabulary-resolver-test.cpp`。
- 操作：
  - catalog 部分，逐条移植：
    - 标准名优先于别名，与文件中的顺序无关。
    - `resolveFinestBasics` 的全部用例。
    - `hierarchyText` 的精确字符串用例。
    - 真实词表中每个词条只列出一次。
    - 数据驱动：`test-data/vocabulary/resolve-cases.json` 的 55 条用例逐条执行。
  - 名称解析器部分，逐条移植：
    - 用户映射优先；映射到已不在词表中的名称时忽略。
    - 只细化到后代，或者同分类父项下的词条。
    - 模型无可用结果时走本地匹配；`unresolvedNames` 去重。
- 验证：T tests/domain/catalog.test.ts tests/domain/vocabulary-resolver.test.ts。

## 17. 测试：识别层、内置数据与数据库在第一阶段后的调整
- 文件：
  - `tests/recognition/request-builder.test.ts`
  - `tests/recognition/response-parser.test.ts`
  - `tests/recognition/vocabulary.test.ts`
  - `tests/data/builtin.test.ts`
  - `tests/data/db.test.ts`
  - `tests/data/name-mappings.test.ts`（新建）
- 出处：
  - `Q:app/tests/recognition/request-builder-test.cpp`、`Q:app/tests/recognition/response-parser-test.cpp`
  - `Q:app/tests/data/builtin-data-test.cpp`、`Q:app/tests/data/database-test.cpp`、`Q:app/tests/data/name-mappings-test.cpp`
- 操作：
  - request-builder：提示词带分层词表，版本是 v3。
  - response-parser：只做 resolve，不细化。
  - vocabulary：Qt 已删除 `vocabulary-test.cpp`。这个文件里与 Catalog 无关、只测已删除功能的用例要删掉，并在回复中列出删了哪些；其余保留。
  - builtin：词表数量改为 581。菜谱相关的断言**本步骤保留**，步骤 60 再处理。
  - db：迁移后共 17 张表；版本 1 的库能升级到 2，新列取默认值；版本比代码新的库拒绝打开。
  - name-mappings：列出、忘记、清空；remember 按 key 覆盖；`deleteAllData` 会清空映射。
- 验证：T tests/recognition/request-builder.test.ts tests/recognition/response-parser.test.ts tests/recognition/vocabulary.test.ts tests/data/builtin.test.ts tests/data/db.test.ts tests/data/name-mappings.test.ts。

## 18. 测试：导入流程中的名称解析与 AI 归类
- 文件：`tests/services/import-flow.test.ts`。
- 出处：`Q:app/tests/ui/application-service-test.cpp`（查找 classif、aiClassified、remember 相关用例）。
- 操作：
  - 用 `RecordedChatClient` 或假 ChatClient 注入 classifier。
  - 新增以下用例：
    - 未解析的名称被归类后，标记为 aiClassified。
    - 归类失败时导入仍然成功，名称为 `未归类`。
    - 用户改名后来源为 user-edited。
    - 确认入库后会记住 ai-classified 和 user-edited 的名称；recognized 和 local-match 不记住。
    - 下次导入同名商品直接命中 user-mapping。
    - 演示模式下不调用 classifier。
  - 原有用例按新行为调整预期，并在回复中逐条列出改了哪些。
- 验证：T tests/services/import-flow.test.ts。

## 19. domain：物资类型、状态与用量解析
- 文件：`shared/enums.ts`、`server/domain/texts.ts`、`server/domain/quantity.ts`（新建）。
- 出处：
  - `Q:app/src/core/fridge-item.h`、`Q:app/src/core/fridge-item.cpp`
  - `Q:app/src/core/texts.h`
  - `Q:app/src/core/quantity.h`、`Q:app/src/core/quantity.cpp`（`:19-132`）
  - `Q:app/src/data/store.h` 中的 ImportStatus
- 操作：
  - `enums.ts` 增加：
    - `ItemKind = food | staple_seasoning | staple_food`，未知值回落到 food。
    - `ItemStatus` 增加 `discarded`。
    - `ImportStatus = confirmed | skipped_duplicate`。
  - `texts.ts` 增加“待录保质期”“已扔掉”，以及出处中新增的其他文案。
  - `quantity.ts`：`parseAmount(text) -> {value, unit}`（value 为 0 或 unit 为空表示未知）、`totalAmount(text, count)`：
    - 先做 NFKC 归一化，再转小写。
    - 单位按长度降序匹配。
    - 计量单位换算表、计数单位列表、中文数字（半、一到十、两）、乘号（`×`、`x`、`*`，且必须紧挨着），全部照抄出处。
    - 先取第一个计量单位 token，没有再取第一个计数单位 token。
    - 小于等于 0 视为未知。
    - `totalAmount` 只在解析结果已知时乘以 `max(1, count)`。
- 验证：TC。另执行 `pnpm exec tsx -e "import('./server/domain/quantity.ts').then(m=>console.log(JSON.stringify([m.parseAmount('250ml*6盒'),m.parseAmount('半斤'),m.totalAmount('3个',2)])))"`，输出 `[{"value":1500,"unit":"ml"},{"value":250,"unit":"g"},{"value":6,"unit":"个"}]`。

## 20. domain：冰箱分组排序与可续传任务状态机
- 文件：`server/domain/fridge-groups.ts`、`server/domain/resumable-job.ts`（都是新建）。
- 出处：
  - `Q:app/src/core/fridge-groups.h`、`Q:app/src/core/fridge-groups.cpp`（`:8-71`）
  - `Q:app/src/core/resumable-job.h`、`Q:app/src/core/resumable-job.cpp`
- 操作：
  - `classifyItemKind(name, recognizedAsSeasoning, storage, catalog, shelfLifeTable)`：规则照抄出处，包括常温保存少于 30 天算 food。
  - `FridgeGroup` 依次为冷藏、冷冻、常温、常备调料、常备食材。`groupOf(item)`：常备类按 kind 分组，其余按存放位置分组。
  - `sortForFridge(items, today)` 的排序键依次为：分组、剩余天数是否未知、剩余天数（未知按 0）、显示名、id。效果是过期的在前，然后剩余天数升序，未知的在后，结果稳定。
  - `ResumableJob`：
    - 任务状态有 pending、running、done、failed；批次状态有 pending、done、failed。
    - 方法：`start`、`plan(count)`、`completeBatch(i, result)`、`fail`、`reset`、`nextBatch`、`results`。
    - 静态方法 `restore(state, batches)`：数据不一致时返回 null；Running 恢复为 Failed，并把 nextBatch 对应的批次标为 Failed。
    - 状态与字符串 key 能互相转换。
- 验证：TC。

## 21. data：物资表的新列
- 文件：`server/data/store.ts`。
- 出处：`Q:app/src/data/store.cpp`（items 的读写部分）、`Q:app/src/core/fridge-item.h`。
- 操作：
  - store 的物资类型增加 `kind`、`amount`、`unit`、`snoozedUntil`（`YYYY-MM-DD` 或 null）。
  - `insertItem`、`updateItem`、`item`、`items` 读写这 4 列。
  - 增加 `isSnoozed(item, today)` 和 `needsShelfLife(item)`，写在 domain 或 store 类型旁，规则照抄 Qt。
- 验证：TC。

## 22. data：导入的软删除、删除历史与跳过记录
- 文件：`server/data/store.ts`。
- 出处：`Q:app/src/data/store.cpp`（`:399` importFingerprints、`:500` deleteImport、`:526` clearImportHistory、imports、insertImport）。
- 操作：
  - 导入记录类型增加 `status`、`duplicateOf`、`deletedAt`。`insertImport` 写入这三个字段。
  - `deleteImport(id)` 在一个事务内依次：
    1. 把图片路径加入 file_cleanup 队列；
    2. 删除 import_products；
    3. 删除该次导入 pending 状态的建议；
    4. 删除该次导入**状态为 in_stock** 的物资；
    5. 删除 import_images；
    6. 设置 `deleted_at`。

    提交事务后执行 `retryFileCleanup`。导入记录行保留，不删除。
  - 新增 `clearImportHistory()`：对每个未删除的导入，清理图片和 products 并设置 `deleted_at`，不删除任何物资。
  - `imports(includeDeleted = false)`，默认排除已删除的导入；`importFingerprints` 也随之排除。
- 验证：TC。

## 23. data：导入任务的持久化
- 文件：`server/data/store.ts`。
- 出处：`Q:app/src/data/store.cpp`（`:578` 起 insertImportJob、saveImportJob、writeImportJob、importJob、importJobRows、deleteImportJob）。
- 操作：
  - `insertImportJob(payload, job)`、`saveImportJob(id, job)` 各自在一个事务内：
    - 更新任务状态；
    - 删除 index 大于等于 batchCount 的批次；
    - 对每个批次执行 upsert（state、result、updated_at）。
  - `importJob()` 取最新一条，用 `ResumableJob.restore` 恢复；数据不一致时写 warn 日志并返回 null。
  - `importJobRows()` 返回全部行，包括无法恢复的。
  - `deleteImportJob(id)` 级联删除批次。
- 验证：TC。

## 24. recognition：按批回调与从指定批次开始
- 文件：`server/recognition/types.ts`、`server/recognition/deepseek.ts`、`server/recognition/replay.ts`，以及演示识别器所在文件。
- 出处：
  - `Q:app/src/recognition/recognition-service.h`、`Q:app/src/recognition/recognition-types.h`（firstBatch、batchSucceeded）
  - `Q:app/src/recognition/deepseek-recognizer.cpp`
- 操作：
  - 识别请求增加 `firstBatch?: number`（默认 0）和 `onBatch?: (index, count, part) => void`。
  - DeepSeek 识别器：
    - 从 firstBatch 开始发送；越界时失败，错误为 invalid-input。
    - 每批成功后先调用 onBatch，再发下一批。
    - 回调期间如果收到取消，就停止。
  - 回放和演示识别器忽略这两个参数。
- 验证：TC。

## 25. services：KitchenService 的排序、扔掉、忽略与删除历史
- 文件：`server/services/kitchen-service.ts`。
- 出处：`Q:app/src/ui/kitchen-service.h`、`Q:app/src/ui/kitchen-service.cpp`（`:24` attention、`:63` saveItem amount、`:179` discardItem、`:189` snoozeItem，以及 clearImportHistory、changeStorage、classify）。
- 操作：
  - `fridge()` 返回 `sortForFridge` 排好的结果。
  - 新增 `attention()`：返回临期或超出估计期限、且没有被忽略的物资，已排序。
  - 新增 `discardItem(id)`：只对在库物资生效，状态改为 discarded，并写入 statusChangedAt。
  - 新增 `snoozeItem(id)`：只对新鲜度恰好是临期的在库物资生效，`snoozedUntil` 设为 today+1。
  - 新增 `clearImportHistory()`。
  - `saveItem`：
    - 手动添加时用 `totalAmount` 计算用量。
    - 编辑时只有 quantityText 或 count 变了，才重新计算用量。
    - 新增和编辑都通过 classify 重新计算 kind。
  - `changeStorage` 重新计算 kind。
  - `nearCount` 不计被忽略的物资。
  - 现有 `deleteImport` 的行为随 store 改为软删除。
- 验证：TC。

## 26. services：调料与常备品入库，跳过重复导入
- 文件：`server/services/import-service.ts`。
- 出处：`Q:app/src/ui/import-service.cpp`（confirm、recalculate 约 `:411`、`:516-520` amount、`:606` skipDuplicate）。
- 操作：
  - 每次 recalculate 都对草稿项调用 `classifyItemKind`，写入 kind 和 needsShelfLife。
  - `confirm`：
    - 删掉调料必须映射到词表的校验；日期校验对所有选中的项都执行。
    - 每个选中的项都插入为物资，写入 amount、unit、importId。
    - 名称不在词表中的项，插入后跳过常备建议。
    - 在词表中的项，常备建议逻辑不变。
  - 新增 `skipDuplicate()`：
    - 前提：草稿存在、当前不忙、且草稿被判定为重复。
    - 插入一条导入记录：不带图片，status 为 skipped_duplicate，duplicateOf 为被重复的导入 id。
    - 不写物资、图片和 products。
    - 然后执行 discard（删除草稿图片和任务）。
- 验证：TC。

## 27. services：导入任务落库与断点续传
- 文件：`server/services/import-service.ts`。
- 出处：`Q:app/src/ui/import-service.cpp`（start、`:293` batchSucceeded、succeeded、recognitionFailed、jobPayload、encodeBatch、resultFromJob、restoreJobPayload、`:682` resume、hasUnfinishedJob、discardUnfinishedJob、dropStoredJobs、confirm、discard）。
- 操作：
  - 只有图片导入建任务；文字导入不落库，粘贴的文字也不写进数据库。
  - `start`：
    - 第一次执行 `insertImportJob`，重试时执行 `saveImportJob`。
    - 识别请求带上 `firstBatch = job.nextBatch()` 和 onBatch 回调。
    - onBatch 里如果 `plan(count)` 失败（批次数变了），就取消本次请求，reset 任务后从第 0 批重新开始；否则执行 `completeBatch` 并保存。
  - 识别成功且有批次结果、任务为 done 时，用全部已存批次重建结果：逐批解析，再 `mergeResults`。
  - 识别失败时执行 `job.fail()` 并保存。
  - payload JSON 包含 inputKind、origin、createdAt、isDemo，以及每张图片的 path、sha256、mimeType、capturedAt、capturedAtSource。批次 result 为 `{firstImage, lastImage, response}`。
  - `hasUnfinishedJob()` 等于“当前没有收到新导入，并且库里有可恢复的任务”。
  - `resume()`：
    - 校验图片都存在、都是普通文件、都位于 `imports/` 目录下，否则 discard 并返回错误“导入的图片已不在，请重新导入”。
    - 任务为 done 时，直接用存下的结果重建草稿，不发请求。
    - 否则只从 nextBatch 开始发送。
    - 不再次征求隐私同意。
  - `discardUnfinishedJob()`：删除全部任务行及其图片，但不删除仍被任何导入（包括已软删除的）引用的图片。
  - `receive` 先清理旧任务。
  - `confirm` 在提交事务内删除任务；`discard` 和 `skipDuplicate` 删除任务及其图片。
- 验证：TC。

## 28. services：状态视图与 DTO 的新字段
- 文件：`server/services/app-state.ts`、`shared/api.ts`。
- 出处：`Q:app/src/ui/app-model.cpp`（`:298` itemMap 的 days 文案、draftItems、imports、attentionCount、nearCount）、`Q:app/src/ui/app-model.h`。
- 操作：
  - `ItemDto` 增加 `kind`、`group`（中文分组名）、`needsShelfLife`、`snoozed`。
  - `days` 文案只有三种：`剩余N天`、`过期N天`（N 取正数）、`待录保质期`；都不适用时为空串。
  - `DraftItemDto` 增加 `kind` 和 `needsShelfLife`。
  - 导入记录 DTO 的名称：跳过的记录在末尾加 ` · 已跳过`。
  - `StateDto` 增加 `attentionCount` 和 `hasUnfinishedImport`。
  - `nearCount` 不计被忽略的物资。
- 验证：TC。

## 29. routes：第二阶段新增接口
- 文件：
  - `server/routes/items.ts`
  - `server/routes/import.ts`
  - `server/routes/profile.ts`（或者现有 `DELETE /api/imports/:id` 所在的文件）
  - `shared/api.ts`
  - `client/api.ts`
- 操作：新增以下路由，并在 `shared/api.ts` 的路由常量表和 `client/api.ts` 中加入对应方法。每条都用 JSON schema 校验，错误统一返回 `{error}` 和中文提示：
  - `POST /api/items/:id/discard`
  - `POST /api/items/:id/snooze`
  - `DELETE /api/imports`（删除历史）
  - `POST /api/import/skip`
  - `POST /api/import/resume`
  - `POST /api/import/discard-unfinished`
- 验证：TC。

## 30. client：冰箱五分组与左滑操作
- 文件：`client/pages/FridgePage.tsx`、`client/components/PantryRow.tsx`。
- 出处：`Q:app/qml/pages/FridgePage.qml`、`Q:app/qml/components/PantryRow.qml`。
- 操作：
  - 冰箱按 `item.group` 分成五张卡片，依次为冷藏、冷冻、常温、常备调料、常备食材，空组不显示。后两组的图标用 `star`。
  - 行内只显示 `days` 文案，去掉来源和“估计”字样。
  - 左滑露出的按钮依次为“用掉”“扔掉”“家里没有”。临期且没有被忽略的行，多出一个“忽略”。露出宽度随按钮数增加。
  - “扔掉”调用 discard，“忽略”调用 snooze，成功后刷新状态。
  - 按钮的 aria-label 写成“用掉X”“扔掉X”“忽略X”“X家里没有”的形式，其中 X 是物资名。
- 验证：TC && B。

## 31. client：导入面板的跳过、常备调料与待录保质期
- 文件：`client/pages/ImportFlowPage.tsx`。
- 出处：`Q:app/qml/pages/ImportFlowPage.qml`。
- 操作：
  - 重复导入状态下的“放弃”按钮改为“跳过”，调用 skip。
  - 草稿页在重复导入时，在“仍然入库”上方加一个描边样式的“跳过”按钮。
  - 调料组标题改为“常备调料 · N 项”。
  - `needsShelfLife` 为 true 的项显示“待录保质期”。
- 验证：TC && B。

## 32. client：继续导入条与删除历史
- 文件：`client/pages/FridgePage.tsx`、`client/pages/ProfilePage.tsx`。
- 操作：
  - 冰箱页标题下方：`hasUnfinishedImport` 为 true 时显示一条横幅“有未完成的导入”，带两个按钮：
    - “继续”：调用 resume，并打开导入面板。
    - “放弃”：调用 discard-unfinished。
  - 我的页的导入记录区新增“删除历史”按钮。点击后弹出 ConfirmDialog（破坏性样式），文案为“只删除导入记录和截图，冰箱里的食材不受影响。”，确认后调用 `DELETE /api/imports`。
- 验证：TC && B。

## 33. 测试：用量解析、分组排序与可续传任务
- 文件：`tests/domain/quantity.test.ts`、`tests/domain/fridge-groups.test.ts`、`tests/domain/resumable-job.test.ts`（都是新建）。
- 出处：`Q:app/tests/core/quantity-test.cpp`、`Q:app/tests/core/fridge-groups-test.cpp`、`Q:app/tests/core/resumable-job-test.cpp`。
- 操作：逐条移植，包括：
  - parse 的全部数据行，以及 totalAmount。
  - kindRule 的 8 行；过期在前、然后剩余天数、未知在后；分组顺序固定；排序稳定；常备品没有保质期时要求录入。
  - 任务按序执行到 done；失败后从失败批次续传；恢复已持久化的行；拒绝不一致的行；reset；key 往返。
- 验证：T tests/domain/quantity.test.ts tests/domain/fridge-groups.test.ts tests/domain/resumable-job.test.ts。

## 34. 测试：数据库 v2 与 Store 的第二阶段行为
- 文件：`tests/data/db.test.ts`、`tests/data/store.test.ts`。
- 出处：`Q:app/tests/data/database-test.cpp`、`Q:app/tests/data/store-test.cpp`。
- 操作：
  - db：版本 1 升级到 2 后，各新列取默认值（kind 为 food、amount 为 0、unit 为空、status 为 confirmed）。
  - store：
    - 删除导入后，已吃掉的物资保留；手动添加的物资不受影响。
    - 删除历史不会清空冰箱。
    - 跳过的重复导入有记录。
    - 已删除的导入不参与指纹比对。
    - 导入任务的往返读写。
    - 任务写到一半失败时整体回滚。
  - 每个用例都用 `fs.mkdtemp` 建临时目录。
- 验证：T tests/data/db.test.ts tests/data/store.test.ts。

## 35. 测试：KitchenService 第二阶段行为
- 文件：`tests/services/kitchen.test.ts`、`tests/domain/household-rules.test.ts`。
- 出处：`Q:app/tests/ui/application-service-test.cpp`（discardAndSnooze、manualItemsGetAnAmount、clearingHistoryKeepsTheFridge、deletingAnImportKeepsWhatWasEaten）、`Q:app/tests/core/household-rules-test.cpp`。
- 操作：
  - 移植上述用例，并补充以下用例：
    - 冰箱排序。
    - attention 不含被忽略的物资。
    - 只有临期物资能被忽略。
    - 改存放位置后重新计算 kind。
  - household-rules 按 Qt 现状调整调料相关的预期。
- 验证：T tests/services/kitchen.test.ts tests/domain/household-rules.test.ts。

## 36. 测试：导入流程的入库、跳过与续传
- 文件：`tests/services/import-flow.test.ts`。
- 出处：`Q:app/tests/ui/application-service-test.cpp`（seasoningsAndStaplesBecomeStock、skippedDuplicatesAreRecorded、resumeSendsOnlyUnfinishedBatches、finishedJobResumesWithoutRecognition、unfinishedJobsCanBeDiscardedOrReplaced、unrestorableJobsStillFreeTheirImages、textImportsAreNotPersisted）。
- 操作：
  - 逐条移植。
  - 续传用例：用 `tests/helpers/fake-http-server.ts` 加真实的 `DeepSeekRecognizer`，构造 3 批，第 2 批返回 500 两次。然后用同一个数据目录新建 service 并调用 resume，断言只重发第 2、3 批，且第 2 批的请求体与原来的字节一致。
- 验证：T tests/services/import-flow.test.ts。

## 37. 测试：第二阶段路由
- 文件：`tests/routes/api.test.ts`。
- 操作：用 `fastify.inject` 覆盖以下路由的成功情况和校验失败（非法 id、状态不允许）：discard、snooze、`DELETE /api/imports`、`import/skip`、`import/resume`、`import/discard-unfinished`。
- 验证：T tests/routes/api.test.ts。

## 38. ai：服务端用户密钥存储与模式切换
- 文件：`server/ai/user-keys.ts`（新建）、`server/services/app-state.ts`。
- 出处：
  - `Q:app/src/ui/user-keys.h`、`Q:app/src/ui/user-keys.cpp`
  - `Q:app/src/platform/key-vault.h`
  - `Q:app/src/platform/desktop/file-key-vault.cpp`
  - `Q:app/src/ui/settings-model.cpp`（`:76` saveSecret）
  - `Q:app/src/ui/app-model.cpp`（`:82-93`、`:160-165` applyModeCredentials）
- 操作：
  - `UserKeyStore(dataDir)`：
    - 存储文件是 `<dataDir>/secrets.json`，目录权限 0700，文件权限 0600。
    - 键名为 `deepseek-key`、`lexmount-key`、`lexmount-project-id`。
    - 写入前 trim；值为空等同于删除；值含空白或控制字符时拒绝。
    - 保留一份进程内缓存。
    - 同时实现 `CredentialProvider`。
  - 密钥字段与 Service 的对应：`deepseek`→deepseek、`lexmount`→lexmount、`lexmountProject`→lexmountProjectId。
  - `keySource(field)` 返回值：用户有值时为 `user`；没有但环境变量有值时为 `builtin`；否则为 `none`。
  - app-state：
    - 真实模式用 `Layered(userKeys, env)`，演示模式只用 `env`。
    - 切换模式、保存或清除密钥时，调用 `chatClient.setCredentials(...)`。
    - `secrets.json` 永远放在真实数据目录，不随演示模式切换。
- 验证：TC。

## 39. data：偏好记录存储
- 文件：`server/data/store.ts`。
- 出处：`Q:app/src/data/store.cpp`（`:974` addPreference 及相关方法）、`Q:app/src/core/preference.h`。
- 操作：
  - `addPreference(text, source = "user")`：
    - 先压缩空白（等同 simplified），再截到 100 个字符。
    - 最多 50 条；完全重复时拒绝。拒绝时返回 0。
  - `updatePreference`（不查重）、`deletePreference`、`preferences()`。
  - 摘要存在 settings 的 `preference_summary` 和 `preference_summary_source` 两个键里。
- 验证：TC。

## 40. ai：偏好摘要整理器
- 文件：`server/ai/preference-summarizer.ts`（新建）。
- 出处：`Q:app/src/ai/preference-summarizer.h`、`Q:app/src/ai/preference-summarizer.cpp`（`:49-68`）。
- 操作：
  - 请求参数：jsonMode true，thinking false，temperature 0，maxTokens 600，idle 20000，deadline 40000。
  - 输入最多 50 条，每条最多 100 字。user 消息为 `<偏好记录>\n1. …\n</偏好记录>`。
  - system 提示词逐字照抄出处。
  - 回答格式为 `{"summary":"…"}`：合成一行，截到 200 字。summary 缺失或为空时 reject BadResponse。
- 验证：TC。

## 41. services：设置服务
- 文件：`server/services/settings-service.ts`（新建）、`server/services/app-state.ts`。
- 出处：`Q:app/src/ui/settings-model.h`、`Q:app/src/ui/settings-model.cpp`（`:76` saveSecret、`:189` summarize、cookingSystemPrompt，以及错误文案）。
- 操作：
  - 密钥：`saveSecret(field, value)`、`clearSecret(field)`、`services()`。`services()` 只返回每个字段的 source，**绝不返回值**。
  - 偏好：增、删、改、列出。
  - `summarize()`：
    - 没有偏好时什么也不做；没有 key 时报错“未配置密钥”。
    - 进行中如果偏好被增、删、改，就中止这次整理并丢弃结果。
    - 成功时写入 summary 和 source。失败时保留旧摘要，错误文案照抄 Qt（网络不可用、请求超时、密钥无效、额度不足或请求过多、整理失败）。
    - 当 `stale` 为 true 时显示“待整理”，判断依据是存下的 source 与当前偏好列表不一致。
    - 删光偏好时清空摘要的两个键。
  - `cookingSystemPrompt(base)`：用 `buildSystemPrompt` 生成，偏好摘要放最后。
  - 名称映射：`nameMappings()`、`forgetNameMapping(raw)`、`clearNameMappings()`。演示模式下返回空列表。
  - app-state 负责持有它，并在切换模式时重新挂载到当前会话的 store。
- 验证：TC。

## 42. routes：服务、偏好与名称映射接口
- 文件：`server/routes/settings.ts`（新建）、`server/main.ts`（注册路由）、`shared/api.ts`、`client/api.ts`。
- 操作：新增以下路由，每条都有 JSON schema 校验，并加入路由常量表和 client 方法：
  - `GET /api/services`：返回 `{deepseek, lexmount, lexmountProject}`，每项是 `user|builtin|none`。
  - `PUT /api/services/:field`：body 为 `{value}`；`DELETE /api/services/:field`。两个接口的响应都只有状态，不含值。
  - `GET /api/preferences`：返回 `{items, summary, stale, summarizing}`。
  - `POST /api/preferences`：body 为 `{text}`；`DELETE /api/preferences/:id`。
  - `POST /api/preferences/summarize`：等待整理结束后返回最新的偏好状态。
  - `GET /api/name-mappings`、`DELETE /api/name-mappings/:raw`、`DELETE /api/name-mappings`。
- 验证：TC。

## 43. scripts：启动脚本导出 Lexmount 凭据
- 文件：`scripts/dev.sh`、`scripts/start.sh`。
- 出处：`Q:scripts/env.sh`（`:33-50` 的 lexmount_config_value 和 export_lexmount_credentials）。
- 操作：
  - 照出处的读法，从 `${WHILEFRESH_LEXMOUNT_CONFIG:-$HOME/.config/lexmount/config.yaml}` 读取 `api-key` 和项目 id 两个字段，键名以出处为准，导出为 `WHILEFRESH_LEXMOUNT_API_KEY` 和 `WHILEFRESH_LEXMOUNT_PROJECT_ID`。
  - 读不到时只提示“未配置 Lexmount，菜谱搜索不可用”，然后继续运行。
  - 保持 `set -euo pipefail`，不用 `set -x`，不 echo 任何值。
- 验证：`bash -n scripts/dev.sh scripts/start.sh && ! rg -n 'set -x|echo .*(KEY|PROJECT)' scripts/`。

## 44. client：服务页
- 文件：`client/pages/ServicesPage.tsx`、`client/components/KeyField.tsx`（都是新建）、`client/pages/ProfilePage.tsx`。
- 出处：`Q:app/qml/pages/ServicesPage.qml`、`Q:app/qml/components/KeyField.qml`。
- 操作：
  - 三个 KeyField，标签依次为“DeepSeek 密钥”“Lexmount 密钥”“Lexmount 项目 ID”。
  - 每个 KeyField 包含：密码输入框（`type=password`、`autocomplete=off`）、状态文字（已配置、内置、未配置）、“保存”和“清除”按钮，失败时显示“保存失败”或“清除失败”。
  - 保存成功后清空输入框，并刷新状态。
  - 我的页加入“服务”入口，压入页面栈。
- 验证：TC && B。

## 45. client：偏好记忆页
- 文件：`client/pages/PreferencesPage.tsx`（新建）、`client/pages/ProfilePage.tsx`。
- 出处：`Q:app/qml/pages/PreferencesPage.qml`。
- 操作：
  - 偏好的输入与添加，失败时显示“添加失败”；列表每项可删除，来源是 ai 的项显示“AI”标签。
  - “整理”按钮，以及摘要显示和“待整理”标记。
  - “已记住的名称”列表，可单条删除，也可“全部清除”（需二次确认）。
  - 我的页加入“偏好记忆”入口。
  - 所有文案照抄出处。
- 验证：TC && B。

## 46. 测试：用户密钥存储与凭据切换
- 文件：`tests/ai/user-keys.test.ts`（新建）。
- 出处：`Q:app/tests/platform/file-key-vault-test.cpp`、`Q:app/tests/ui/settings-model-test.cpp`（key 相关的用例）。
- 操作：覆盖以下用例：
  - 跨实例往返读写；覆盖与删除。
  - 文件权限 0600，目录权限 0700。
  - 拒绝非法值。
  - source 依次为 user、builtin、none。
  - 真实模式下用户密钥优先；演示模式不读用户密钥。
  - 不带环境变量时需要用户密钥。
- 验证：T tests/ai/user-keys.test.ts。

## 47. 测试：偏好存储、整理器与设置服务
- 文件：`tests/ai/preference-summarizer.test.ts`、`tests/services/settings.test.ts`（都是新建），以及 `tests/data/store.test.ts`。
- 出处：`Q:app/tests/ai/preference-summarizer-test.cpp`、`Q:app/tests/ui/settings-model-test.cpp`、`Q:app/tests/data/store-test.cpp`（偏好相关的用例）。
- 操作：
  - 整理器：
    - 短的纯文本 JSON 请求；输入上限；回答合成一行并截断；坏回答失败；取消静默。
    - **回放录制**：用 `test-data/recordings/preferences/synthetic-preferences.json`，校验 digest，期望摘要为 `不吃香菜；少油；复杂菜只在周末做。`。digest 对不上时按步骤 15 的规则输出 FAIL。
  - 设置服务：摘要的完整生命周期；整理中编辑会丢弃结果；没有 key 或没有偏好时不发请求；失败时保留旧摘要；摘要在烹饪提示词的最后；名称映射的列出、忘记和清空。
  - store：偏好的 100 字截断、50 条上限、拒绝重复。
- 验证：T tests/ai/preference-summarizer.test.ts tests/services/settings.test.ts tests/data/store.test.ts。

## 48. 测试：服务与偏好路由
- 文件：`tests/routes/api.test.ts`。
- 操作：
  - 覆盖 `/api/services*`、`/api/preferences*`、`/api/name-mappings*` 的成功情况和校验失败（未知字段名、含空白的值、超长文本）。
  - **断言**：保存了值为 `test-key-123` 的密钥后，所有 `/api/*` GET 接口的响应体都不包含这个字符串。
  - 断言 `data/secrets.json` 不在测试的数据目录之外。
- 验证：T tests/routes/api.test.ts。

## 49. recipes：菜谱类型、契约对象与下厨房解析器
- 文件：`server/recipes/types.ts`、`server/recipes/contract.ts`、`server/recipes/xiachufang-parser.ts`（都是新建）。
- 出处：
  - `Q:app/src/recipes/recipe-types.h`、`Q:app/src/recipes/recipe-types.cpp`
  - `Q:app/src/recipes/contract-document.cpp`
  - `Q:app/src/recipes/xiachufang-yaml-parser.cpp`
  - `Q:app/src/recipes/recipe-source.h`
- 操作：
  - `types.ts`：
    - 数据类型：RecipeSummary、RecipeAttribution、WebRecipe、RecipeIngredient、RecipeStep、RecipeSearchResult。
    - `RecipeErrorKind` 共 10 种，以及 `RecipeError`。
    - `RecipeSource` 接口：`search(keyword, page, signal)`、`detail(id, signal)`、`isConfigured()`。
  - `contract.ts`：`buildContract(operation, query, scraped)` 把抓取结果转成契约对象，字段和 schema_version 与 Qt 生成的 YAML 结构一致。本步骤不涉及 YAML。
  - `xiachufang-parser.ts`：
    - `parseContract(obj)` 输出 SearchResult 或 WebRecipe。
    - 只接受 schema 主版本 1，其他版本返回 BadResponse。
    - status 为 error 时按 message 映射：含 timeout 为 Timeout，含 not found 或 404 为 NotFound，incomplete 含 query 为 InvalidQuery，其余为 Unavailable。
    - status 为 partial 时设置 `partial`。
    - 来源固定为 xiachufang；`source_url` 作为回原页的链接。
    - 输入格式不对时永远不抛异常，返回 BadResponse。
- 验证：TC。

## 50. recipes：CDP 连接
- 文件：`server/recipes/cdp-connection.ts`（新建）。
- 出处：`Q:app/src/recipes/cdp-connection.h`、`Q:app/src/recipes/cdp-connection.cpp`。WebSocket 帧编解码由 Node 内置的 `WebSocket` 负责，不需要移植 `websocket-codec`。
- 操作：
  - 基于全局 `WebSocket` 实现 `CdpConnection(url)`：
    - `open(signal)`。
    - `send(method, params, sessionId?)`：返回 Promise，用自增 id 匹配响应；每步默认超时 20000ms，可注入。
    - `on(event, handler)`、`close()`。
  - 单条消息超过 4 MiB 时关闭连接并报错。
  - 连接断开时，所有未完成的调用 reject，错误类型为 NetworkError。
- 验证：TC。

## 51. recipes：Lexmount 菜谱源
- 文件：`server/recipes/lexmount-source.ts`（新建）。
- 出处：`Q:app/src/recipes/lexmount-recipe-source.h`、`Q:app/src/recipes/lexmount-recipe-source.cpp`（抓取脚本在 `:24-65`，逐字复制）。
- 操作：
  - 构造参数：`{ credentials: () => ({apiKey, projectId}), baseUrl = "https://api.lexmount.cn", fetch?, timeouts? }`。
  - 默认时限：每个 HTTP 请求 15s，等待会话就绪 40s，每个 CDP 步骤 20s，等待页面 30s，整个请求 90s，清理 8s。pageSize 为 20。
  - 流程照抄出处：
    1. `POST /instance/v2` 创建会话，请求体逐字照抄。session id 依次从 session_id、sessionId、instance_id、id 中取。
    2. 每 300ms 轮询 `POST /instance/session`，直到会话就绪；状态字符串照抄出处。
    3. 请求 `GET /json/version?session_id=`，优先取 `webSocketDebuggerUrlTransformed`。
    4. 通过 CDP 依次调用 Target.getTargets、Target.attachToTarget（flatten）、Page.enable、Runtime.enable、Page.navigate。
    5. 每 300ms 轮询页面状态，直到页面就绪；按出处的兜底规则识别验证页。
    6. 用 Runtime.evaluate（awaitPromise）执行抓取脚本，然后 `buildContract`，再 `parseContract`。
    7. **无论成功、失败、超时还是取消**，都执行 `DELETE /instance`，body 为 `{"session_id":…}`。创建请求还在进行时被取消，也要等它返回后再删除会话。
  - 页面地址：
    - 搜索：`https://www.xiachufang.com/search/?keyword=<kw>&cat=1001&page=<n>`
    - 详情：`https://www.xiachufang.com/recipe/<id>/`
  - 参数校验：keyword 为 1–200 字，id 为 1–20 位数字，不合法时为 InvalidQuery；没有凭据时为 NotConfigured。这两种错误都异步返回。
  - 错误映射：
    - 401/403 为 AuthFailed；429 或 5xx 为 Unavailable。
    - 超时为 Timeout；连接断开或导航失败为 NetworkError。
    - 页面脚本异常为 Unavailable。
    - 验证页或拦截页为 Blocked，标题匹配 `验证|安全|拦截|captcha|denied|forbidden`。
  - HTTP 响应体超过 4 MiB 时拒绝。
  - 请求头 `x-api-key` 和 `x-project-id` 的值不写日志。
- 验证：TC。

## 52. services：网页菜谱服务与装配
- 文件：`server/services/web-recipe-service.ts`（新建）、`server/services/app-state.ts`、`server/main.ts`。
- 出处：`Q:app/src/ui/web-recipe-service.h`、`Q:app/src/ui/web-recipe-service.cpp`（`:15-27` 错误文案）、`Q:app/src/ui/app-model.cpp`（`:86-93` m_web 装配与 reset）。
- 操作：
  - `WebRecipeService(source)`：
    - `search(keyword, page, signal)`：新的搜索会中止上一次搜索。
    - `detail(id, signal)`：详情只缓存在内存里，不落库。
    - `reset()`：清空缓存，并中止进行中的请求。
    - 错误一律转换成出处中的中文短文案。
    - 详情 DTO 包含：id、name、imageUrl、rating、`ingredients[{raw}]`、`steps[{order,text,imageUrl}]`、tips、partial、`attribution{source:"下厨房", url, author}`。
  - app-state 装配 `LexmountRecipeSource`：credentials 回调从当前模式的 provider 取 lexmount 和 lexmountProjectId。切换模式、保存或清除密钥时调用 `web.reset()`。演示模式同样使用环境变量里的 Lexmount 凭据，与 Qt 一致。
- 验证：TC。

## 53. routes：网页菜谱接口
- 文件：`server/routes/web-recipes.ts`（新建）、`server/main.ts`、`shared/api.ts`、`client/api.ts`。
- 操作：
  - 新增 `GET /api/web-recipes?keyword=&page=` 和 `GET /api/web-recipes/:id`，用 schema 校验 keyword 长度、page 范围和 id 格式。
  - 用 `request.raw` 的 `close` 事件中止上游请求。
  - 失败时返回 `{error: 中文文案}`，状态码 502；参数错误返回 400。
  - 在路由常量表和 client 方法中加入这两个接口。client 方法支持传入 AbortSignal。
- 验证：TC。

## 54. client：菜谱搜索页
- 文件：`client/pages/RecipesPage.tsx`（整页替换）、`client/App.tsx`（如需要）。
- 出处：`Q:app/qml/pages/RecipesPage.qml`。
- 操作：
  - 页头为“菜谱 / 下厨房”，下面是“搜索菜名”输入框。按钮文字在“搜下厨房”和“取消搜索”之间切换，取消时 abort 请求。
  - 结果列表每行显示名称和“下厨房”标签。
  - 三种状态：搜索中显示“搜索中…”；出错显示错误文案；没有结果显示空状态“没有找到菜谱”。
  - 点击一行压入 WebRecipeDetailPage（由步骤 55 新建；本步骤先压入占位页，以保证编译通过）。
  - 页面接收可选的 `initialKeyword`，有值时填入输入框并立即搜索。
- 验证：TC && B。

## 55. client：菜谱卡（网页菜谱详情）
- 文件：`client/pages/WebRecipeDetailPage.tsx`（新建）、`client/pages/RecipesPage.tsx`（把占位页换成正式页面）。
- 出处：`Q:app/qml/pages/WebRecipeDetailPage.qml`。
- 操作：
  - 标题为“菜谱卡”。
  - 依次显示：菜名；“来源：下厨房”，内容不全时加“ · 内容不全”；“查看原菜谱”链接（`target=_blank rel=noopener`）；“用料”（每行原文）；“步骤”（`序号. 文本`）；每条小贴士显示为“小贴士：…”。
  - 离开页面时中止请求。
  - 加载中和出错的状态要显示出来。
- 验证：TC && B。

## 56. client：清冰箱改为搜下厨房，删除本地菜谱界面
- 文件：
  - `client/pages/ClearFridgePage.tsx`
  - `client/App.tsx`、`client/nav.ts`（如需要）
  - `client/pages/ShoppingPage.tsx`
  - 删除 `client/pages/ClearResultsPage.tsx`、`client/pages/RecipeDetailPage.tsx`、`client/components/RecipeCard.tsx`
- 出处：`Q:app/qml/pages/ClearFridgePage.qml`（约 `:116`）、`Q:app/qml/Main.qml`、`Q:app/qml/pages/ShoppingPage.qml`。
- 操作：
  - 清冰箱页：
    - 标题和 chip 照抄出处，保留默认选择。
    - 删除预览和“重置推荐选料”。
    - 按钮“搜下厨房”在至少选中一项时可用。点击后把所选物资的显示名用单个空格连接成关键词，切换到菜谱 tab，并把关键词作为 `initialKeyword` 传给菜谱页。
  - 删除上面三个文件，以及所有引用它们的代码。
  - 待买页删除空状态中的“选择菜谱后，可把缺料加入这里”。
  - client 不再调用 `/api/recipes*` 和 `/api/clear/*`；对应方法从 `client/api.ts` 中删除。
- 验证：TC && B && `! rg -n "api/recipes|api/clear|addMissing|RecipeCard|ClearResults" client`。

## 57. server：移除 HowToCook 菜谱与匹配器
- 文件：
  - 删除 `assets/data/recipes.json`、`server/domain/recipe.ts`、`server/routes/recipes.ts`、`server/routes/clear.ts`
  - 修改 `server/data/builtin.ts`、`server/services/kitchen-service.ts`、`server/main.ts`、`server/services/app-state.ts`、`shared/api.ts`
  - 删除 `tests/domain/recipe-matcher.test.ts`
- 出处：`Q` 的提交 `995615d`（`git -C ../whilefresh show --stat 995615d`），以及 `Q:app/src/data/builtin-data.cpp`。
- 操作：
  - builtin 只加载 `vocabulary.json` 和可选的 `shelf-life.json`。
  - kitchen-service 删除 recipes、clearFridge、clearFridgePreview、recipe 和 addMissing。
  - 删除对应的路由注册、DTO（RecipeSummaryDto、RecipeDetailDto、ClearPreviewDto 等）和路由常量。
  - 待买功能和 `ShoppingOrigin` 的取值保留。
  - 删除只测试已删除代码的测试文件 `recipe-matcher.test.ts`。其余测试文件中引用已删除 API 的部分，只做让它编译通过的最小删除，具体断言留给步骤 60。
- 验证：TC && B && `! rg -n "recipes\.json|matchRecipe|rankForClearFridge|HowToCook" server shared client`。

## 58. 测试：下厨房解析器与录制菜谱源
- 文件：`tests/helpers/recorded-recipe-source.ts`、`tests/recipes/xiachufang-parser.test.ts`、`tests/recipes/recorded-recipe-source.test.ts`（都是新建）。
- 出处：`Q:app/tests/recipes/xiachufang-yaml-parser-test.cpp`、`Q:app/tests/recipes/recorded-recipe-source-test.cpp`、`Q:app/src/recipes/recorded-recipe-source.cpp`。
- 操作：
  - 执行 `pnpm add -D yaml`。
  - helper：读取 `test-data/recipes/xiachufang/*.yaml`，用 `yaml` 解析成对象。按文件里回显的查询登记（keyword 加 page，或 id），返回值经 `parseContract` 处理。未登记的请求返回 NotFound；结果异步返回。
  - 逐条移植解析器测试：搜索样例、详情样例、partial、各种错误状态的映射、schema 版本、空结果、未知状态、格式错误的输入。
  - 逐条移植录制菜谱源测试。
- 验证：T tests/recipes/xiachufang-parser.test.ts tests/recipes/recorded-recipe-source.test.ts。

## 59. 测试：Lexmount 菜谱源（本地假 Lexmount 与 CDP 服务）
- 文件：`tests/helpers/fake-lexmount-server.ts`、`tests/recipes/lexmount-source.test.ts`（都是新建）。
- 出处：`Q:app/tests/recipes/fake-lexmount-server.h`、`Q:app/tests/recipes/lexmount-recipe-source-test.cpp`。
- 操作：
  - 执行 `pnpm add -D ws @types/ws`。
  - 用 `node:http` 和 `ws` 实现假的 Lexmount HTTP 接口和 CDP WebSocket。
  - 逐条移植全部用例，包括：
    - 等到导航到目标页之后再抓取。
    - 用精确的 DELETE 请求删除会话。
    - 跳过没有名称的行；ping 不影响流程。
    - 非菜谱页面返回 Blocked 并带标题；没有列表的搜索页返回空结果。
    - 出错、鉴权失败、超时、取消时都删除会话，包括创建过程中被取消。
    - 被取消请求的迟到回复不会混进下一个请求。
    - 搜索和详情互相独立。
    - 缺凭据或输入错误时异步失败。
    - 服务不可达返回 NetworkError。
  - 时限调小注入。
- 验证：T tests/recipes/lexmount-source.test.ts。

## 60. 测试：网页菜谱服务、路由与移除菜谱后的剩余测试
- 文件：`tests/services/web-recipe-service.test.ts`（新建）、`tests/routes/api.test.ts`、`tests/data/builtin.test.ts`、`tests/domain/household-rules.test.ts`、`tests/services/kitchen.test.ts`。
- 出处：`Q:app/tests/ui/web-recipe-service-test.cpp`、`Q:app/tests/data/builtin-data-test.cpp`、`Q:app/tests/core/household-rules-test.cpp`。
- 操作：
  - 网页菜谱服务（用 recorded helper）：只显示当前这次请求的结果；详情带来源信息并缓存在内存中；错误转成中文短文案；reset 丢弃缓存；cancel 能停掉搜索和详情两个请求。
  - 路由：`/api/web-recipes` 的成功、参数校验失败和上游错误。用 `fastify.inject` 时注入 recorded source，不访问网络。
  - 删除其余测试中依赖已删除菜谱或匹配器的用例，与 Qt 的删除保持一致，并在回复中列出删了哪些。
- 验证：T tests/services/web-recipe-service.test.ts tests/routes/api.test.ts tests/data/builtin.test.ts tests/domain/household-rules.test.ts tests/services/kitchen.test.ts。

## 61. 测试：端到端演示流程更新
- 文件：`e2e/demo-flow.spec.ts`。
- 操作：保持 412×915 视口和演示模式，流程改为：
  1. 开启演示。
  2. 截图导入（和现在一样），草稿页把一项“移入调料”、一项“移入已忽略”，然后确认入库。
  3. 断言冰箱出现“常备调料”分组。对一项左滑，点“扔掉X”，确认该行消失。
  4. 编辑一项并记住规则（和现在一样）。
  5. 进入清冰箱，至少选中一项后点“搜下厨房”，断言菜谱页输入框里是所选物资的名称。用 `page.route('**/api/web-recipes**', …)` 拦截请求，返回固定 JSON：搜索 1 条结果，详情包含用料、步骤和链接。点开结果后断言出现“菜谱卡”和“查看原菜谱”。
  6. 待买页断言空状态。
  7. 在我的页打开“服务”，断言三项状态文字可见，页面上不出现任何密钥值。
  8. 我的页删除全部数据。
  - 断言控制台没有 error。
  - 如果在当前沙箱里浏览器无法启动，输出 FAIL 并写明原因。不要改 `playwright.config.ts` 去绕过。
- 验证：E2E。

## 62. 测试：全量回归与密钥检查
- 文件：无。
- 操作：执行全量类型检查、单元测试、构建和 e2e，然后扫描密钥，并确认运行时文件没有被 git 跟踪。
- 验证：
  - `TC && pnpm test > /tmp/wfw-test.log 2>&1 || { tail -60 /tmp/wfw-test.log; false; }`
  - B && E2E
  - `! rg -uu -l -e 'sk-[0-9a-f]{32}' --glob '!node_modules/**' --glob '!.cache/**' .`
  - `! git ls-files | rg -n '(^|/)secrets\.json$|^data/'`
  - `git -C ../whilefresh status --short | wc -l` 的输出与执行前一致，确认没有改动 Q。

## 63. 文档：开发文档
- 文件：`docs/development.md`。
- 操作：增加和更新以下内容：
  - 密钥来源：服务页保存在 `data/secrets.json`（0600，不进 git，接口永不回传值）；环境变量相当于“内置”；用户密钥优先；演示模式只用环境变量。监听地址不是本机时，同网段的人能改写密钥，这一点并入原有的安全说明。
  - Lexmount：环境变量 `WHILEFRESH_LEXMOUNT_API_KEY`、`WHILEFRESH_LEXMOUNT_PROJECT_ID`，脚本从 `~/.config/lexmount/config.yaml` 读取；每次搜索或查看详情都会开一个云浏览器会话，按次计费，可能遇到滑块验证。
  - 费用：AI 归类、偏好整理和菜谱搜索都会调用付费服务；测试全部离线。
  - 数据库迁移 2 对应 Qt schema v5。
  - 内置数据不再包含菜谱。
  - 新增的测试目录：`tests/ai`、`tests/recipes`、`tests/helpers`。
- 验证：`rg -n 'secrets.json|WHILEFRESH_LEXMOUNT_API_KEY|tests/recipes' docs/development.md`。

## 64. 文档：README 与 FHS
- 文件：`README.md`、`FHS.md`。
- 操作：
  - README：
    - 状态改为“已对齐 Qt 第二轮 T13–T17、T18b”。
    - 功能列表：删除 HowToCook 和 372 道菜；加入下厨房搜索、AI 归类、常备调料入库、软删除导入、断点续传、服务页和偏好记忆。
    - 技术栈增加 Lexmount。
    - 许可部分删除 HowToCook 一行，并注明菜谱内容来自下厨房、仅限试用、不缓存正文。
  - FHS：
    - Layout 增加 `server/ai/`、`server/recipes/`、`tests/helpers/`、`docs/codex-plan.md`，删除 `assets/data` 中的菜谱。
    - Placement rules 增加 ai 层和 recipes 层的依赖规则，以及“抓取脚本和选择器集中在 `lexmount-source.ts`”。
    - Change log 加一条 2026-11-01 的记录。
- 验证：`rg -n 'server/ai|server/recipes' FHS.md && rg -n '下厨房' README.md && ! rg -n 'HowToCook|372' README.md FHS.md`。

## 65. 文档：AGENTS 并提交
- 文件：`AGENTS.md`。
- 操作：
  - 项目概述写明“已对齐 Qt main 第二轮 T13–T17、T18b，T18–T21 未开始”。
  - 分层依赖加入 `ai` 和 `recipes`。
  - 安全与隐私加入 `secrets.json` 和 Lexmount 凭据的规则。
  - 然后执行：`git add -A`；用 `git status --short` 确认只有本计划涉及的文件，并且没有 `data/`、`secrets.json`、`node_modules/`；再执行 `git commit -m "docs: describe round-2 web port"`。不加 `Co-Authored-By`，不推送，不合并。
- 验证：`rg -n 'recipes' AGENTS.md && git status --short | wc -l` 的输出为 `0`。
