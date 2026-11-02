# 趁鲜 WhileFresh · Web

帮家里**趁新鲜用掉已买食材**的手机网页应用。把买菜 App 的截图、订单文字或购物小票交给它，它整理出冰箱里有什么、哪些该先用，再从有来源的菜谱里找出能做的菜，缺的料列进待买清单。

> **状态**：由 Qt / Android 版（[me-chjiang/whilefresh](https://github.com/me-chjiang/whilefresh) 的 `app/`）重写而来，已对齐 Qt 第二轮 T13–T17、T18b；单元 / 集成测试与演示模式端到端测试已通过，尚未做真机浏览器走查。代码注释里的 `app/src/...` 行号指向原 Qt 工程，作为行为出处。

## 功能

- **入库**：相册截图（可多张）、拍购物小票、粘贴订单文字或手动添加。AI 识别并按食材、调料和无关内容归类，提取规格和可见的生产日期，用户核对后才入冰箱。
- **常备入库**：调料确认入库后可归到常备调料，常备食材和调料都能直接管理。
- **可靠导入**：导入记录采用软删除，保留删除历史；长任务支持断点续传。
- **冰箱**：按冷藏 / 冷冻 / 常温分区，显示新鲜 / 临期 / 超出估计期限，随日期变化。
- **保质期有依据**：包装标注 > 你确认过的规则 > USDA FoodKeeper 参考表 > AI 估计，每项标出来源。
- **清冰箱做饭**：默认选中临期和标记先用的食材，搜索下厨房菜谱，查看用料、步骤和原菜谱链接。
- **待买**：缺料按品类整理，可复制或分享。
- **常备规则**：盐、油、酱油等默认算家里有，可增删；系统的建议都需你确认。
- **服务页**：配置 DeepSeek 与 Lexmount 凭据，密钥保存在服务端数据目录。
- **偏好记忆**：记录口味和饮食习惯，由 AI 整理成简洁摘要，用于后续烹饪提示。
- **演示模式**：内置示例数据与预设识别结果，不联网、不影响真实数据。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vite + React 19（TypeScript strict），移动端优先 |
| 服务端 | Node 24 + Fastify 5，`tsx` 运行；默认只监听 `127.0.0.1` |
| 本地存储 | SQLite（`node:sqlite`），带版本迁移，数据在 `data/` |
| 识别 | DeepSeek 多模态 API，由服务端调用，密钥只在服务端；sharp 切片、exifr 读拍摄日期 |
| 菜谱 | Lexmount 云浏览器访问下厨房，按次计费 |
| 内置数据 | `assets/data/`：标准食材词表、保质期参考表 |
| 测试 | Vitest（单元 / 集成）、Playwright（端到端） |

## 快速开始

需要 Node 24 和 pnpm。完整说明见 [docs/development.md](docs/development.md)。

```sh
pnpm install                     # 安装依赖（项目本地）
scripts/dev.sh                   # 开发：服务端 + Vite 热更新
scripts/start.sh                 # 构建并以生产模式启动，访问 http://127.0.0.1:5174
pnpm typecheck && pnpm test      # 类型检查与单元测试
pnpm e2e                         # 端到端测试（首次先 pnpm exec playwright install chromium）
```

脚本从 macOS 钥匙串（条目 `landing-project-deepseek`）读取 DeepSeek 密钥，只传给服务端；没有密钥时可在「我的」中开启演示模式。服务没有鉴权，默认只监听本机。

## 目录

```
server/     服务端：domain/ data/ ai/ recognition/ recipes/ import/ services/ routes/
client/     React 前端：api.ts、components/、pages/、styles/
shared/     前后端共用的枚举与 API 契约
assets/     内置数据、字体、纹理、图标、演示预设
tests/      Vitest；e2e/ 为 Playwright
test-data/  合成样本、标准答案与识别录制
scripts/    启动脚本
```

各目录的放置规则见 [FHS.md](FHS.md)。

## 许可

本项目代码采用 [BSD 3-Clause](LICENSE)。第三方内容：

- 保质期参考 [USDA FoodKeeper](https://catalog.data.gov/dataset/fsis-foodkeeper-data) — CC0
- 图标 [Tabler Icons](https://github.com/tabler/tabler-icons) — MIT（`assets/icons/LICENSE-tabler`）
- 标题字体 Noto Serif SC — SIL OFL 1.1（`assets/fonts/OFL.txt`）

菜谱内容来自下厨房，仅限试用，不缓存正文。
