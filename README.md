# 趁鲜 WhileFresh · Web

帮家里**趁新鲜用掉已买食材**的手机网页应用。把买菜 App 的截图、订单文字或购物小票交给它，它整理出冰箱里有什么、哪些该先用，再从有来源的菜谱里找出能做的菜，缺的料列进待买清单。

> **状态**：由 Qt / Android 版（[me-chjiang/whilefresh](https://github.com/me-chjiang/whilefresh) 的 `app/`）重写而来，单元 / 集成测试与演示模式端到端测试已通过，尚未做真机浏览器走查。代码注释里的 `app/src/...` 行号指向原 Qt 工程，作为行为出处。

## 功能

- **入库**：相册截图（可多张）、拍购物小票、粘贴订单文字或手动添加。AI 识别商品、规格和可见的生产日期，分出食材、调料和无关内容，用户核对后才入冰箱。
- **冰箱**：按冷藏 / 冷冻 / 常温分区，显示新鲜 / 临期 / 超出估计期限，随日期变化。
- **保质期有依据**：包装标注 > 你确认过的规则 > USDA FoodKeeper 参考表 > AI 估计，每项标出来源。
- **清冰箱做饭**：默认选中临期和标记先用的食材，从 372 道 [HowToCook](https://github.com/Anduin2017/HowToCook) 菜谱中按“用到所选最多、缺料最少”排序。
- **待买**：缺料按品类整理，可复制或分享。
- **常备规则**：盐、油、酱油等默认算家里有，可增删；系统的建议都需你确认。
- **演示模式**：内置示例数据与预设识别结果，不联网、不影响真实数据。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vite + React 19（TypeScript strict），移动端优先 |
| 服务端 | Node 24 + Fastify 5，`tsx` 运行；默认只监听 `127.0.0.1` |
| 本地存储 | SQLite（`node:sqlite`），带版本迁移，数据在 `data/` |
| 识别 | DeepSeek 多模态 API，由服务端调用，密钥只在服务端环境变量中；sharp 切片、exifr 读拍摄日期 |
| 内置数据 | `assets/data/`：菜谱、标准食材词表、保质期参考表 |
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
server/     服务端：domain/ data/ recognition/ import/ services/ routes/
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

- 菜谱 [HowToCook](https://github.com/Anduin2017/HowToCook) — Unlicense
- 保质期参考 [USDA FoodKeeper](https://catalog.data.gov/dataset/fsis-foodkeeper-data) — CC0
- 图标 [Tabler Icons](https://github.com/tabler/tabler-icons) — MIT（`assets/icons/LICENSE-tabler`）
- 标题字体 Noto Serif SC — SIL OFL 1.1（`assets/fonts/OFL.txt`）
