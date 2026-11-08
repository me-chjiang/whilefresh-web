# 交接文档

记录跨会话的未决问题与待定事项。新会话开工前先读这里；问题解决后从本文件删除对应条目。

## 当前状态（2026-11-03）

- 分支 `feat/round-2`：codex-plan 第 0–65 步全部落地，并在验收中追加了几处修复（重复导入按钮、无参数接口请求体约定、迁移 3 的查重标记、偏好整理错误提示）。尚未合并到 `main`。
- 真实服务验收：DeepSeek 识别与 AI 归类正常；**下厨房菜谱不可用**，见下节。

## 未决：下厨房对 Lexmount 云浏览器稳定弹滑动验证

**现象**

- 菜谱搜索与详情都返回“下厨房拦截”（接口 502）。
- 2026-11-03 连续 4 次真实调用（搜索“西兰花 虾仁”“西兰花”“番茄炒蛋”，详情 `103468406`）全部失败，错误详情相同：
  `not a recipe page: title="滑动验证" at www.xiachufang.com/auth/humancheck_captcha/`。
- 每次约 11–13 秒，说明 Lexmount 会话正常建立、页面正常加载，是下厨房把请求导向了人机验证页。

**已排除**

- 不是凭据问题：`~/.config/lexmount/config.yaml` 的 api-key、project-id 均已配置，`scripts/start.sh` 会导出。
- 不是解析或判定的缺陷：拦截判定与 Qt 一致（`server/recipes/lexmount-source.ts`，Blocked 分支见提交 `c2cd3aa`）。

**预热实验（2026-11-03，临时脚本已删）**

- 用临时脚本 `scripts/lexmount-probe.mts` 走了一遍：`Page.navigate` 到首页、停留 2s、再跳搜索页，全程记录 `document.title`/`host`/`pathname`。
- 首页正常：`title="下厨房"`、`path="/"`、无验证。说明不是 Lexmount 出口 IP 被整站封禁。
- 搜索页仍被重定向到 `/auth/humancheck_captcha/`，`title="滑动验证"`，URL 带 `xcf_token` 和 `next=<原搜索地址>` 两个参数。
- 结论：拦截是**搜索端点级**的，不是会话/IP 信誉级；首页预热无法规避。`next` 参数说明验证通过后能回跳到结果页，对“人工过一次验证后复用会话”（下方方向 3）是一个可用线索。

**全机制实验（2026-11-03，临时脚本 `/tmp/lexmount-probe.mjs`，未入库）**

对详情 `103468406` 用 Lexmount 逐机制尝试，**全部**被重定向到阿里云滑块验证（`/auth/humancheck_captcha/`，`title="滑动验证"`，HTML 里可见 `--aliyun-slide-width` 等标记）：

- Web Fetch API（`POST /v1/extract`，engine `lightmount_lite` / `lightmount_dcl`）：拦截。`lightmount_lite` 返回的正文是“This is a captcha verification page…”的英文说明，即下厨房对 Web Fetch 出口同样拦截。
- 云浏览器 `enable_captcha=false`（现状默认）：拦截。
- 云浏览器 `enable_captcha=true`（Lexmount 自动验证码）：仍拦截，未能自动过阿里云滑块。
- 云浏览器 `browser_mode=light` + `enable_captcha=true`：仍拦截。
- 会话创建返回 HTTP 202（异步），`region_id` 在 `nanjing-1` / `beijing-1` 间按容量分配；不同区域出口都被拦，说明是 Lexmount 出口 IP 池整体被下厨房标记，不是单个 IP。

结论：Lexmount 当前任何机制都拿不到菜谱详情，`enable_captcha` 对阿里云滑块无效；上面的“搜索端点级”判断被推翻——详情端点同样被拦。只剩方向 3：用 `inspectUrl = {base}/inspect?session_id=…` 的实时画面让用户人工过一次验证后复用会话（或持久化 context），需用户本人操作、会话过期后仍会再拦，且可能触条款。

**相关代码**

- 抓取脚本、选择器与目标 URL：`server/recipes/lexmount-source.ts`（`targetUrl`、`Page.navigate`）。
- 错误文案与状态：`server/services/web-recipe-service.ts`（`errorLabel`）、`server/routes/web-recipes.ts`（`failureStatus`）。
- 前端入口：`client/pages/ClearFridgePage.tsx`（“搜下厨房”）、`client/pages/RecipesPage.tsx`、`client/pages/WebRecipeDetailPage.tsx`。

**复现**

用 `scripts/start.sh` 启动（建议设 `WHILEFRESH_DATA_DIR` 为临时目录，不动真实数据），在清冰箱选两样食材点“搜下厨房”。也可以写一个小脚本直接调用 `LexmountRecipeSource.search()`，打印捕获到的错误的 `kind` 和 `detail`。

**可选方向**

1. 改为在用户自己的浏览器或下厨房 App 中打开搜索页：保留“用冰箱食材拼关键词”，放弃 App 内菜谱卡。不会被拦，也不需要 Lexmount。
2. 换一个允许程序获取内容的菜谱源（开放许可的数据集或有正式 API 的平台），保留 App 内菜谱卡。
3. 用户本人在会话里手动过一次验证，之后低频复用该会话。前提是 Lexmount 支持持久化会话和实时查看；会话过期后仍会被拦，可能与下厨房条款冲突。只算缓解。
4. 先查清触发条件：`config.yaml` 里还有一个 `base-url` 字段，`start.sh` 没有导出，代码默认用 `https://api.lexmount.cn`；还可对比 Qt 版当前是否同样被拦（首页预热已测、无效，见上节）。这些只用于判断方向，不做反检测。

## 其他待定事项

- 冰箱左滑的“扔掉 / 忽略”是 Qt 界面没有的，由计划第 30 步加入；需决定是否保留。
- `AGENTS.md` 仍写“行为规格以原 Qt 工程为准”，但 Web 与 Qt 现已是两个独立项目，需改写这条。
- Playwright MCP 会在仓库根目录生成 `.playwright-mcp/`，目前未被 `.gitignore` 忽略。
- `tests/ai/deepseek-chat-client.test.ts` 的并发用例在全量运行时偶发 200 ms 空闲超时，单独运行稳定。属于时序不稳定，与功能无关。
