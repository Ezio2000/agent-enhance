# Agent Enhance

宿主无关的 AI 额外能力基座，当前提供 **Pi 专属适配包 `pi-enhance`**。由 grok-enhance、muse-enhance、openai-codex-enhance 重构而来。非供应商官方项目；真实调用可能消耗订阅／API 额度并上传显式输入文件。

## 架构

- `packages/core`：能力契约、注册合并、路由、认证接口、配置与模块管理；不依赖 Pi。
- `packages/capabilities/<功能>/<供应商>`：纯功能实现，不读 Agent 的凭据文件，不注册宿主工具。
- `packages/transports/<供应商>`：协议、认证目标地址校验及跨功能辅助代码。
- `packages/hosts/pi`：Pi 工具、命令、登录态解析、UI 与生命周期桥接。
- `dist/core.mjs`：可脱离 Pi 导入的自包含基座。未来宿主只需实现契约；**当前没有声称支持 Claude Code**。

供应商 ID 为 `openai`、`xai`、`opencode`、`minimax`、`zai`。Codex／Go 是渠道，Grok／Muse 是模型，不作为供应商目录。

## 安装与迁移

需要 Node.js >=22、Pi >=0.86.1 的兼容扩展 API。

```bash
pi install https://github.com/Ezio2000/agent-enhance
```

GitHub 仓库为 `Ezio2000/agent-enhance`，Pi 集成包名为 `pi-enhance`。**日常安装与更新只使用 Git 远端**，不把开发工作树注册为持久 Pi 包来源。后续更新执行 `pi update https://github.com/Ezio2000/agent-enhance`。开发者先按 [发布流程](docs/release.md) 提交并推送源码、构建模块及锁定目录，再从远端更新；未推送的本地构建不会出现在 Git 安装中。

如果先前把本地工作树装进 Pi，先安装远端来源，再移除本地来源（路径按 `pi list` 确认；只保留一个 `pi-enhance`）：

```bash
pi install https://github.com/Ezio2000/agent-enhance
pi remove /absolute/path/to/agent-enhance
pi list
```

切换后在 Pi 中执行 `/reload`，按下方“模块更新”流程更新已安装能力，再 `/reload` 载入新模块。`~/.agent-enhance` 中的偏好、认证和历史产物不会因切换包来源而删除。

若之前从旧仓库 URL 安装，先安装新地址，再移除旧来源（使用 `pi list` 显示的来源字符串）：

```bash
pi remove https://github.com/Ezio2000/openai-codex-enhance
```

移除单独安装的 grok-enhance、muse-enhance 等来源，并重启 Pi 或执行 `/reload`。不要同时加载其他 `pi-enhance` 来源；同一工具的冲突会在加载时明确报错。能力及偏好保存在 `~/.agent-enhance`，切换安装来源不移动认证或历史产物。

新安装默认**不安装、不加载任何能力**，不会启动桌面进程或调用模型。打开 `/pi-enhance` 按功能选择供应商，或直接一步启用：

```text
/pi-enhance openai gen_image enable
/pi-enhance xai gen_image enable
/pi-enhance defaults gen_image openai
/pi-enhance status
```

安装粒度是 **功能 × 供应商**：启用 `gen_image/openai` 只安装该模块，不附带搜索、桌面操作或其他供应商。面板按图片、视频、语音、搜索、文件理解、桌面操作和请求增强分组，展示大小、平台、认证要求，以及安装／加载／自动加载状态。选择动作后返回，Esc 取消不修改。

| 操作                       | 行为                                                   |
| -------------------------- | ------------------------------------------------------ |
| `enable`                   | 缺失时安装 → 当前会话加载 → 保存自动加载               |
| `disable`                  | 卸载当前实例并取消自动加载，保留安装与控制偏好         |
| `install`                  | 仅安装，不自动加载，也不下载云端模型权重               |
| `load` / `load --save`     | 当前会话加载；加 `--save` 保存自动加载                 |
| `unload` / `unload --save` | 当前会话卸载；加 `--save` 取消自动加载                 |
| `uninstall`                | 禁用并移除安装记录，保留历史产物和内容寻址缓存         |
| `manage`                   | 打开模块管理面板；已加载的请求增强仍可用原快捷设置入口 |

旧命令保持兼容。`enable` 不隐式更新已安装的旧模块，不修改 `fast` 等控制值；已有控制值会在重新启用后恢复作用。安装或启用不会调用收费模型、启动桌面运行时或自动登录；认证通过 Pi `/login` 配置，`status` 单独显示认证与工具可用性。加载／保存失败时不新增自动加载偏好；已校验的安装文件可以保留供重试。

### 模块更新

先更新 Pi 包并执行 `/reload`，取得新模块目录，再显式更新已安装模块：

```text
/pi-enhance updates
/pi-enhance update --installed
# 或只更新一个模块
/pi-enhance openai gen_image update
```

`updates` 只比较当前主包携带的目录与安装记录，不联网查询最新版。主包升级不会自动安装或更新能力。批量更新先校验全部目标，再一次性切换安装记录；失败保留旧记录。更新不加载模块、不修改偏好，也不替换当前实例；新代码在后续卸载／加载或 `/reload` 后使用。目录与模块使用精确哈希匹配，不能把保留旧缓存理解成跨主包版本兼容。

### 轻量分发

模块是独立、自包含的 ESM 文件。安装复用已校验缓存，或从本地仓库构建产物／目录锁定的 Git commit 获取，校验 SHA-256 与长度后提交；不运行安装脚本，**不会隐式回退到其他模型、供应商或登录态**。

发布 tarball 只含适配器、目录和文档，不含能力模块。维护者完成 npm 发布后，可用 `pi install npm:pi-enhance` 获得真正按需下载的入口（此说明不代表已经发布）。Git 安装仍会克隆完整仓库，能力的安装与加载保持显式。发布前也可 `npm pack --ignore-scripts`，解压后通过 `pi install /absolute/path/to/package` 使用同样的最小包。

## 能力与工具

| 工具／能力 ID  | 供应商               | 说明                                                                                                                                                     |
| -------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen_image`    | openai、xai、minimax | 图片生成／编辑；只注册一个工具（minimax 仅生成）                                                                                                         |
| `gen_video`    | xai                  | 视频生成                                                                                                                                                 |
| `gen_voice`    | minimax              | 语音合成（TTS），卡片上报真实字符用量                                                                                                                    |
| `view_pdf`     | opencode             | Muse Spark 查看本地 PDF                                                                                                                                  |
| `view_video`   | opencode             | Muse Spark 查看本地视频；不支持音频                                                                                                                      |
| `search_web`   | openai、zai          | 搜索、浏览、图片查询、天气／金融等；zai 走 GLM Coding Plan 工具 API（search_query/open 公共命令，openai 独有命令与 zai 独有参数分列 options.<provider>） |
| `use_computer` | openai               | macOS 原生 Computer Use                                                                                                                                  |
| `view_image`   | zai                  | GLM 视觉看图／看视频（OCR、UI 转代码、报错诊断、图表理解等 8 类任务）；仅在当前模型不能直接读图时注册，消耗 Coding Plan 额度                             |
| `fast`         | openai               | 请求增强，不注册工具                                                                                                                                     |
| `verbosity`    | openai               | 请求增强，不注册工具                                                                                                                                     |
| `image_detail` | openai               | 请求增强，不注册工具                                                                                                                                     |

工具名使用下划线，不带供应商。两个图片模块同时加载时仍只有一个 `gen_image`；卸载某供应商后，其参数会从 Schema 消失。最后一个实现卸载后，工具从活动工具集移除。宿主的工具排除规则仍然有效。

### Pi 子代理

`call_subagents` 是 Pi 宿主专属的编排功能，不是供应商能力模块。代码随轻量 Pi 适配器分发，**默认关闭**，不自动启动子会话或调用模型。显式启用后，主模型可通过只读工具 `view_subagent_models` 查询当前 Pi 可用、符合 scoped-models 限制的模型及其文字／图片／推理元数据；不另设预设 agent。

```text
/pi-enhance subagents enable
/pi-enhance subagents model                       # TUI 选择并记住子代理默认模型
/pi-enhance subagents model minimax-cn/MiniMax-M2.7  # 非交互明确设置
/pi-enhance subagents model inherit               # 清除默认值，继承当前 Pi 模型
/pi-enhance subagents status
/pi-enhance subagents cancel <batch-id>
/pi-enhance subagents disable
```

```json
{
  "tasks": [
    { "context": "搜索官方资料并总结来源", "tools": ["search_web"] },
    { "context": "判断 1=1 是否成立", "model": "minimax-cn/MiniMax-M2.7" }
  ]
}
```

`/pi-enhance` 主面板将子代理作为单独功能分组；进入后可选择默认模型、启用／禁用或查看状态，Esc 取消不修改。命令行仍可直接使用上面的显式命令。启用后，`call_subagents` 的工具提示会引导主模型在独立、可并行或值得第二模型复核的任务中考虑委派；简单问题直接处理。它不是强制自动调用，每次委派仍由主模型决定并消耗相应模型额度。

`context` 是完整的子任务提示词，父会话历史不自动复制。`tools` 可省略或传 `[]`（零工具）；指定时只能使用当前父 Pi 会话活跃的内置工具或已加载的 pi-enhance 工具。子任务的 `model` 优先于已保存的子代理默认模型；两者都没有时继承当前 Pi 模型。默认值保存在 `~/.agent-enhance/hosts/pi.json`，跨会话保留；如果保存的模型后来不可用或不在当前 scoped models 中，明确报错而不静默换模型。显式指定也必须使用 Pi 当前可用且位于当前 scoped models 中的精确 `provider/id`。`thinking_level`、`cwd`、`timeout_seconds`、`max_turns` 均可选，后两项不填时本功能不施加额外上限，用户取消及 Pi／供应商限制仍生效。查询目录不调用收费模型，目录可用不保证实际额度。

每个子任务由独立的 **Pi SDK AgentSession** 执行，工具在子会话中显式装配，不手写模型／工具循环。`call_subagents` 仅支持非阻塞：立即返回批次 ID 及每个任务 ID，最多 8 个任务，宿主跨批次最多同时运行 4 个并限制排队数量。`view_subagents()` 列出当前会话批次，`view_subagents({"batchId":"..."})` 查询批次内任务，`view_subagents({"id":"..."})` 查询单个任务及其结果；进度包含排队／运行／取消中／终态、阶段、当前工具、已完成回合、token／费用、耗时和最近最多 3 条可见输出（每条最多 500 字符，助手正文或工具文本，不包含推理）。完成的批次只在当前会话内保留最近 24 个。`cancel_subagents({"batchId":"..."})` 可取消当前会话的活跃批次；排队任务立即取消，运行中先显示 `cancelling`；模型／工具响应 abort 并真正退出后才显示 `cancelled`。TUI 派发卡片原位刷新各任务状态、耗时、最近可见输出及已结算 token／费用（模型尚在生成中的 token 无精确用量；用量在每条助手消息结束时更新），完成卡片展示批次总耗时及展开后的单任务耗时和用量。全部完成后在原会话展示结果并触发后续模型回合（可能额外消耗额度），不会持续向主模型推送进度消息；单纯主模型回合结束或中断不取消批次。`/new`、退出／切换会话、切换分支、禁用或 `/pi-enhance subagents cancel <batch-id>` 会取消任务；旧会话进度不继承到新会话。手动取消只请求中止并抑制该批次的完成通知，不自动触发主模型继续；单任务异常标记 `failed`，不阻塞其它任务，整批结束后连同错误结果一起通知主模型。Pi 原生写入／命令工具（`edit`、`write`、`bash`、`powershell`）及 pi-enhance 生成／桌面工具（`gen_image`、`gen_video`、`gen_voice`、`use_computer`）默认拦截；仅在交互模式得到用户针对本批次的明确批准后才允许。未知的第三方扩展工具不会被假装成可继承工具。工具白名单不是 OS 沙箱，尤其 `bash` 可以写入任意允许的文件。

### 图片参数

公共字段：`provider`、`model`、`prompt`、`images`、`timeout_seconds`。供应商专属字段放在 `options.<provider>`：

```json
{
  "provider": "xai",
  "prompt": "一个蓝色圆形图标，白色背景",
  "model": "grok-imagine-image-2.0",
  "options": { "xai": { "aspect_ratio": "1:1", "resolution": "1k", "quality": "low" } }
}
```

```json
{
  "provider": "openai",
  "prompt": "一个透明背景的蓝色圆形图标",
  "options": { "openai": { "size": "1024x1024", "background": "transparent", "quality": "low" } }
}
```

省略 `provider` 时使用该能力的已保存默认值；没有默认值且只加载一个实现时使用它；多个实现时要求明确选择。主会话模型不会影响路由。不同供应商参数、模型和输入限制不兼容时直接报错，不静默忽略参数。

其他工具保留其功能参数（见各模块 `src/schema.ts`），统一增加可选 `provider`：

```json
{ "provider": "opencode", "path": "/absolute/path/file.pdf", "prompt": "概括要点" }
```

```json
{ "provider": "openai", "search_query": [{ "q": "OpenAI image documentation" }], "include_context": false }
```

图像原件与视频保存后返回路径，预览不替代原件。生成期间进度更新先密后疏（退避），以减少工具块重绘：iTerm2 等终端在每次重绘时会重发内联图片，固定 1 秒刷新会让已生成的图片持续闪烁。生成请求不自动重试；超时不保证远端运算停止。Web 引用原始 URL，网页和屏幕内容都是不可信数据。

## 请求增强

先安装并加载相应模块：

```text
/pi-enhance openai fast install
/pi-enhance openai fast load --save
/pi-enhance openai fast on
/pi-enhance openai verbosity high
/pi-enhance openai image_detail on
```

最后两项也要求事先安装／加载对应模块。`fast` 设置 `service_tier=priority`，可能增加额度消耗；`verbosity` 控制回答详细程度；`image_detail on` 对应 `original`，不关闭宿主图片缩放。`off` 表示不覆盖原请求。仅作用于支持的 OpenAI Codex 主模型请求（包括 GPT-6 Astra、Sol、Luna），不影响独立工具。

`/pi-enhance` 打开按功能分组的管理面板；`/pi-enhance openai fast manage` 管理安装／禁用／更新，`/pi-enhance openai fast` 打开设置选择器，选中即保存并返回，Esc 取消不改值。控制状态以自定义 Footer 呈现：标签显示在项目地址右侧（启用的值高亮），仅在当前主模型为受支持的 OpenAI Codex Responses 模型时出现，切到其他模型即隐藏；其余扩展状态仍在统计行下方。提供命令参数补全，不替换编辑器。非交互模式须提供显式操作或值。

## 认证

基座只认识 `CredentialResolver` 与 `(provider, channel, acceptedKinds)`。Pi 实现委托 `modelRegistry.getProviderAuth()` 获取／刷新认证，不自行扫描或复制认证文件。

| 能力渠道             | Pi 认证来源             | 接受类型                       |
| -------------------- | ----------------------- | ------------------------------ |
| openai / codex       | openai-codex            | 订阅 OAuth                     |
| xai / imagine        | xai                     | OAuth                          |
| opencode / go        | opencode-go             | API Key                        |
| minimax / token-plan | minimax-cn              | Token Plan API Key（`sk-cp-`） |
| zai / coding-plan    | zai（或 zai-coding-cn） | GLM Coding Plan API Key        |

使用 Pi 原生 `/login` 配置对应渠道。平台 OpenAI API Key 不能替代 Codex OAuth。将来其他 Agent 自行实现获取方式与登录引导；现有 `StaticCredentialResolver` 可用于显式配置的独立宿主和测试。凭据只发送至相应供应商的固定受限地址，日志脱敏，拒绝认证请求重定向。

zai 渠道面向 GLM Coding Plan 订阅：search_web/zai 与 view_image/zai 使用订阅额度，计费入口按实测区分 —— 联网搜索走套餐 MCP 端点（`/api/mcp/web_search_prime`，按次计费，与官方 MCP 同口径）；网页阅读走 coding REST（`/api/coding/paas/v4/reader`，也计入套餐次数）；view_image 走多模态 `chat/completions`（glm-5.3-flash，按 token）。注意 coding REST 下的 `web_search` 不计套餐额度（无按量余额时报 1113），搜索必须走 MCP 端点。仅限个人编码场景交互式使用；密钥严禁共享或转售。view_image 的任务提示词来自官方 `@z_ai/mcp-server`（Apache-2.0），原样内置并保留署名。

Muse contributor 模型涉及上游数据使用政策，勿上传机密。Computer Use 使用外部官方运行时，其本地登录／系统权限检查与本项目的云 API 凭据接口分开。

## Computer Use

仅 macOS。需安装兼容 ChatGPT 桌面版，至少启用过一次 Computer Use，使其物化官方插件和签名原生服务，并满足官方本地登录、辅助功能及屏幕录制要求。本项目不下载、复制或绕过官方程序与权限。运行时布局／政策变化可能导致兼容性失败。

```text
/pi-enhance openai use_computer install
/pi-enhance openai use_computer load --save
/pi-enhance openai use_computer status
/pi-enhance openai use_computer ask
/pi-enhance openai use_computer revoke
```

工具首次执行必须只调用 `await cua.getState()` 或 `await cua.getApp('bundle.id')`，读取返回 API 与确认策略后再操作。只启用原生应用 API，不启用浏览器 Tab API。

使用独立 Sky 私有实例；任务完全结束才清理，自动续跑前保持 JS 状态。新任务必须重新初始化。`auto-app` 默认只自动允许普通应用访问，绝不授权发送、删除、付款等敏感操作；未知请求和无交互条件下的敏感请求拒绝。`ask` 切回应用询问模式，`revoke` 撤销会话授权并切回 ask。权限和 JS 状态不跨会话／宿主共享，任何失败不自动重放操作。

## 配置与产物

默认根目录 `~/.agent-enhance`，可通过 `AGENT_ENHANCE_HOME` 覆盖：

```text
modules.lock.json
packages/<hash>-<module>.mjs
hosts/pi.json
artifacts/pi/<capability>/<provider>/<session>/<call>/
```

本版只使用宿主级配置，不自动读取项目级配置。配置原子写入并使用跨进程写锁；损坏配置不会被默认值覆盖。`status` 检查目录中云能力的认证可用性（单模块 `status` 只检查该模块），不执行计费请求；实际模型额度与后端权限仍须调用验证。浏览面板及 `catalog` 只读元数据，不检查认证、不下载模块。

## 开发与验收

```bash
npm ci --ignore-scripts
npm run check                         # 包含离线最小 tarball + 独立 Pi SDK 进程验收
npm run verify:distribution -- --download # 可选：真实下载锁定的公开模块，不调用模型
npm run smoke                         # 仅打印用法，不发起付费请求
npm run smoke -- --live               # search + PDF；上传合成测试文件
npm run smoke -- --live --images      # 两个供应商各生成一张图
npm run smoke -- --live --video       # 合成参考图生成短视频，并交给 Muse 查看
npm run smoke -- --live --computer    # 仅读取桌面应用列表，清理私有运行时
npx tsx scripts/smoke-subagents.ts --live         # 可选：MiniMax/Kimi/GLM 三个无工具子会话，消耗模型额度
npx tsx scripts/smoke-subagent-search.ts --live  # 可选：GLM 子会话调用 search_web/zai，消耗模型和搜索额度
npx tsx scripts/smoke-subagent-host.ts --live    # 可选：Pi 宿主完整派发／回传，消耗 MiniMax 额度
```

测试包含迁移的协议／运行时回归、参数合并、认证隔离、安装完整性、一步启用／禁用、交互取消、批量更新失败恢复、并发安装冲突、Pi 真实 SDK 注册／卸载、宿主工具排除规则和最小安装包隔离验收。真实 smoke 使用现有 Pi 登录态，只发送合成测试内容，记录本地产物，不上传验收结果到仓库。

详见 [架构](docs/architecture.md)、[发布与回滚](docs/release.md)。
