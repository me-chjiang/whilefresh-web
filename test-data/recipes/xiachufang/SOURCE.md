# 下厨房菜谱源样例

菜谱源 YAML 契约（`schema_version` 1.0，字段与外部子模块 `recipe-sources-xiachufang-api` 的 CLI 输出一致）的样例，用于 `app/tests/recipes/` 的解析与回放测试，以及离线开发。

## 文件

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `search-tomato-egg.yaml` | 搜索“番茄炒蛋”第 1 页，保留前 2 条摘要 | 2026-10-30 子模块 CLI，`--provider direct` |
| `search-shrimp.yaml` | 搜索“虾仁”第 1 页，保留前 2 条摘要 | 同上 |
| `error-detail-blocked.yaml` | 详情 107722218，直连被拦截（`unrecognized detail page`），status error | 同上，真实错误输出 |
| `error-invalid-id.yaml` | 详情 id `abc`，参数错误，status error | 同上 |
| `detail-lexmount-103468406.yaml` | 真实详情（虾仁滑蛋），前 3 项食材、前 2 步，含小贴士 | 2026-10-30 `recipe-cli detail`，Lexmount 云浏览器 |
| `detail-lexmount-107114615.yaml` | 真实详情（清炒虾仁），前 3 项食材、前 2 步，无小贴士 | 同上 |
| `detail-partial-synthetic.yaml` | 缺步骤和小贴士的 partial 详情，id 900000002，status partial | **合成**：子模块自己的 `RecipeEngine` 与 `yaml.safe_dump`，输入是固定示例数据（不联网），`source_url` 不指向真实菜谱 |

仓库是公开的，所以：搜索样例从原始输出（15、14 条）裁剪为前 2 条，并把 `pagination.returned` 与 `total_candidates_after_filter` 同步改为 2；两个真实详情只保留前 3 项食材和前 2 步（用 PyYAML 重写，字段与顺序不变）。裁剪后 `status` 仍写 `complete`，这是有意保留的原始值，测试不依赖它与条数的一致性。

## 生成方式

搜索与错误样例：在子模块目录用它自己的 `.venv`（`uv`）运行 CLI，不修改子模块。

```sh
uv run python -m xiachufang_source --provider direct --keyword 番茄炒蛋 > search-tomato-egg.yaml
uv run python -m xiachufang_source --provider direct --keyword 虾仁 > search-shrimp.yaml
uv run python -m xiachufang_source --provider direct --operation detail --id 107722218 > error-detail-blocked.yaml
uv run python -m xiachufang_source --provider direct --operation detail --id abc > error-invalid-id.yaml
```

真实详情：子模块的 Lexmount 路线当前报错，改用本仓库的桌面工具 `recipe-cli`（C++，与应用同一条实现，输出同一契约），凭据只经环境变量传入：

```sh
export WHILEFRESH_LEXMOUNT_API_KEY=...   # 读自 ~/.config/lexmount/config.yaml，不要打印
export WHILEFRESH_LEXMOUNT_PROJECT_ID=...
build/desktop/tools/recipe-cli detail 103468406 --record /tmp/detail.yaml
```

录制后再裁剪到上述条数。`recipe-cli search <词> --record <文件>` 同理。站点有滑动验证：连续请求几次后会返回 `blocked`（title `滑动验证`），隔几十秒再试。

提交前确认没有凭据：

```sh
rg -i 'api.?key|project.?id|credential|token' test-data/recipes/xiachufang
```

只应匹配 `query.lexmount_base_url: null` 这类空字段。

## 使用条款

下厨房内容仅限试用、非商业；保留来源链接与署名（`source_url`、`source.name`），不转载、不打包菜谱正文进应用。样例仅作解析测试，不随应用分发。子模块代码为 Apache-2.0，不授予菜谱正文或图片的转载权。
