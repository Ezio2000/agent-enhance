# openai-codex-enhance

为 pi 增加 Codex 网络搜索、数据查询、图片生成/编辑、原生 macOS Computer Use，以及可选的主模型请求增强。复用 pi 的 OAuth 登录，不依赖 OpenAI SDK。

非 OpenAI 官方扩展；调用会消耗账号额度。

## 安装

需要 Node.js >=22、pi 0.85.1 或兼容版本，并已 `/login openai-codex`。

```bash
pi install /absolute/path/to/openai-codex-enhance
```

已有会话执行 `/reload`。`codex_web`、`codex_image` 与 `codex_computer` 均跨渠道可用：Web/Image 只要求已 `/login openai-codex`（认证取自 pi 保存的 Codex OAuth，仍消耗对应的 Codex 请求／ChatGPT 订阅图片额度）；Computer Use 只要求本机装有兼容的 ChatGPT 桌面版，与当前主模型渠道和 Codex 登录无关。

- `pi remove /absolute/path/to/openai-codex-enhance`：移除扩展。

## 主模型请求开关

```text
/openai-codex-enhance                  # 打开保持开启的设置面板
/openai-codex-enhance verbosity        # 打开面板，定位 verbosity
/openai-codex-enhance verbosity high   # 直接设置
/openai-codex-enhance image-detail     # 打开面板，定位 image-detail
/openai-codex-enhance image-detail on  # 开启 original；off 关闭
/openai-codex-enhance fast             # 打开面板，定位 fast
/openai-codex-enhance fast off         # 直接关闭
/openai-codex-enhance status           # 查看配置
```

面板使用 **↑/↓ 选择、Space 循环切换并立即保存、Esc 退出**，修改一项不会关闭面板；Enter 也可切换但不会退出。无 TUI 时使用显式值命令。

首次默认 **off**，之后作为全局偏好保存到 `~/.pi/agent/openai-codex-enhance.json`（遵循 `PI_CODING_AGENT_DIR`）。**重启、新会话、恢复旧会话和 `/reload` 都沿用已保存值**，分支切换不回滚设置。不写 pi 的 settings.json 或认证文件；原子写入，保存失败不切换状态。首次升级且配置文件不存在时，迁移当前会话的旧设置。

命令、补全、设置面板与 Computer Use 管理对所有 provider 开放；未选择模型时也可配置。在非 Codex provider 下，Codex 专属设置保存为预设，并提示 `(n/a)`。仅对适用的 `openai-codex` provider / `openai-codex-responses` 请求生效，不改变主模型、推理强度、其他 provider 的请求或独立工具参数。关闭表示不覆盖原请求。

Codex 模式下使用自定义 Footer，状态紧跟当前工作目录右侧，整行使用与目录一致的 `dim` 灰色：

```text
~/program/github  verbosity:high  image:original  fast:on(2.5x)
```

下方保留 token、缓存、上下文、模型和用量估计；其他扩展的状态另行保留。非 Codex 时卸载此 Footer、恢复 pi 默认页脚。pi 同时只能使用一个自定义 Footer，本扩展启用时会替换其他自定义 Footer。

- verbosity 设置 `text.verbosity`，控制回答详细程度。
- image-detail 设置用户/工具输入图片的 `detail: original`。**不修改 pi 的自动缩放设置，也不能恢复预览丢失的像素**；需要完整细节时读取保存的原图。
- fast 设置 `service_tier: priority`。[官方规则](https://learn.chatgpt.com/docs/agent-configuration/speed)：ChatGPT 登录时 GPT-5.4 为 **2× credits**，GPT-5.5 / 5.6 / GPT-6 Astra 为 **2.5× credits**。这是额度倍率，不是统一的 API 美元费率；Footer 仅标注倍率，不擅自再次乘算 pi 的用量估计。
- 根据本地 Codex 模型目录核对支持范围，未知或不支持的模型显示 `(n/a)` 并跳过对应覆盖。Footer 表示配置，不是后端已执行的证明。

## 工具

### `codex_web`

搜索请求的 `model` 固定为 **`gpt-5.6-luna`**，不改变主会话模型。任意 provider 的主模型均可调用，仍需保存的 Codex OAuth，额度计入 Codex 服务。

支持 `search_query`、`image_query`、`open`、`click`、`find`、PDF `screenshot`，以及 `finance`、`weather`、`sports`、`time`。

```json
{"search_query":[{"q":"OpenAI 图片生成文档","domains":["developers.openai.com"]}]}
```

```json
{"weather":[{"location":"China, Shanghai, Shanghai","duration":1}],"time":[{"utc_offset":"+08:00"}]}
```

每种操作使用数组，至少提供一种。搜索每类最多 4 个查询，其他操作每类最多 10 个；4 个 `search_query` 要求 `response_length: medium` 或 `long`。

支持域名过滤、地点和上下文设置；完整字段见 [Web schema](src/capabilities/web/schema.ts)。默认输出预算 6000、超时 90 秒。设 `include_context:false` 可关闭近期对话传递。

引用 ID 用于后续浏览，回答引用原始来源 URL。输出上限 2000 行 / 48 KiB，截断时返回完整文件路径。截图和数据查询保留后端文本/结构化结果，不自动下载远端图片。

### `codex_image`

无参考图时生成，有参考图时编辑。**跨渠道可用**：主模型不在 Codex 渠道时同样能调用，OAuth 与当前模型无关；额度仍计入 ChatGPT 订阅。仅开放以下参数：

| 参数 | 用途 |
|---|---|
| `model` | 可选：gpt-image-2.5-flare（默认）、gpt-image-2.5-sunburst、gpt-image-2 |
| `prompt` | 必填；编辑时说明保留和改变的内容 |
| `images` | 每项提供 `path` 或 `image_url`，最多 16 张；不传即纯生成 |
| `size` | auto 或 WIDTHxHEIGHT，默认 auto |
| `background` | auto / opaque / transparent，默认 auto |
| `quality` | auto / low / medium / high，默认 auto |
| `timeout_seconds` | 默认 300，范围 10–600 |

内部固定：**1 张、PNG、stream=true、partial_images=0、moderation=low**（low 不代表关闭安全政策，后端效果未验证，不对工具开放）。不要将这些固定项作为工具参数传入。模型可选，省略时使用 gpt-image-2.5-flare。

```json
{"model":"gpt-image-2.5-flare","prompt":"设计一个蓝色鲸鱼图标"}
```

两款 2.5 模型名已在 Codex 后端完成单次生成实测，但响应没有实际模型标识，不能独立验证内部路由。Sunburst 侧重编辑精度，Flare 侧重日常生成速度。官方参数与本工具支持范围见 [GPT Image 2.5](docs/image-25.md)。

```json
{"prompt":"设计一个蓝色鲸鱼图标，透明背景","background":"transparent"}
```

```json
{"prompt":"把鲸鱼改成绿色，保持形状和构图不变","images":[{"path":"/absolute/path/to/original.png"}]}
```

不支持蒙版、压缩、保真度选项、File ID、Files 管理或 variations。尺寸和质量可能被后端调整；插件报告可观察差异，不修改原图掩盖结果。

### `codex_computer` — 原生桌面操作

复用本机 ChatGPT 安装包中的 **签名 node_repl + Sky 原生服务**，不是 Playwright，也不是额外启动一个 Codex agent。**Sky 服务由本扩展自己拉起一个私有实例**（独立进程 + app group 容器内的私有 socket），完全不依赖 ChatGPT 主程序，也不会连接或复用 ChatGPT 正在跑的共享服务：即使 ChatGPT 桌面版同时运行，两边互不影响，任务结束只回收本扩展自己的实例。**跨渠道可用**（同 `codex_image`）：主模型可以是 pi 中任意 provider 的模型，运行时与审批策略均与主模型无关；Codex 模型针对 cua API 训练过，其他模型完全依赖工具说明与首调返回的官方 API 文档，动作质量可能下降。当前仅支持 macOS，要求安装带 `cua_node` 和 `unified-computer-use` 插件的 ChatGPT 桌面版本，**并至少启动过一次该桌面版以完成插件物化**，同时完成其辅助功能和屏幕录制授权。**无需打开 ChatGPT 聊天界面，但必须保留安装包和原生服务。无需 Codex 账号或 OAuth 登录**：控制链路不读取任何凭据（已用空/不存在的 `CODEX_HOME` 实测）；尚未在从未登录过 ChatGPT 桌面版的全新机器上验证。

首次初始化（一次性，之后 pi 中使用无需 ChatGPT 进程）：

1. **安装 ChatGPT 桌面版**（带 `cua_node` 与 `unified-computer-use` 插件的版本）至 `/Applications/ChatGPT.app`。扩展仅把它当作磁盘文件使用（`node`、`node_repl`、`@oai` 模块、打包 `codex`），启动命令取自桌面版自己物化的插件清单，不启动其主程序。
2. **在 ChatGPT 桌面版中启用一次 Computer Use**：首次配置会把签名 Sky 服务安装到 `$CODEX_HOME/computer-use/Codex Computer Use.app`（桥私有实例的二进制来源），并会把 `cua_repl` 的启动命令物化到 `$CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`，扩展据此发现运行时。
3. **在系统弹窗中授权一次**辅助功能与屏幕录制：TCC 绑定 Sky 服务二进制本身，与 ChatGPT 是否运行无关。
4. **登录一次**，产生 `~/.codex` 登录态。Sky 在每次 cua 操作前需经 `codex app-server` 查询登录态与 Computer Use 政策，该 app-server 由桥拉起的 Sky 实例从安装包内的 `codex` 自行 spawn、纯本地完成，不经任何 ChatGPT 进程。

四项完成后，运行期依赖只剩磁盘上的安装包与 Sky 服务，ChatGPT 可保持完全退出。

`/reload` 后可直接说“用 Computer Use 查看 Safari 当前页面”。首次调用只初始化并查看一个入口，随后遵循工具返回的官方 API 文档：

```json
{"code":"var safari = await cua.getApp('com.apple.Safari');","title":"查看 Safari 当前窗口"}
```

```json
{"code":"await safari.getScreenshot();","title":"读取 Safari 截图"}
```

- 一次任务完全结束前复用 MCP/JS 进程、变量与应用绑定；包括 pi 自动重试/压缩续跑，不再在底层 `agent_end` 处销毁状态。串行处理桌面操作，首次使用返回官方 API 和确认策略。
- 在 `agent_settled`（pi 不再自动续跑）时调用官方 `turn_ended`，随后释放本扩展的运行时连接并停止本扩展自己的 Sky 实例，虚拟光标随私有实例一起回收；**会话应用授权保留，JS 状态不保留**。先尝试 EOF 正常退出，再有界升级到 SIGTERM/SIGKILL，仅针对本扩展自己的进程组和私有服务；不触碰 ChatGPT 或其他 Codex/Sky 进程。
- 下一任务按需重新启动，工具结果与下一轮上下文提示重新初始化变量/app 绑定。运行时错误会标注 JS 状态不确定，不无差别重启、不自动重放动作；AX 索引过期与 JS 变量丢失分别处理。重载、会话/分支切换、切换 provider 时同时清空授权。
- **默认 `auto-app`：普通应用访问自动批准，不再弹扩展的应用授权框**，与 pi 默认直接执行工具的使用方式一致；无 UI 时也可自动批准普通应用访问。这是扩展的默认策略，不是从 `defaultProjectTrust` / `isProjectTrusted()` 推断出的 YOLO 状态，也不会自动检测其他权限扩展。自动批准逐次记录诊断，不生成持久或可复用的手动授权。
- 可用 `computer ask` 切回询问模式：**Deny / Allow once / Allow this app for this pi session**。会话允许仅缓存指定应用的普通访问，不缓存敏感操作；不修改 macOS 权限或 Codex 配置。`computer revoke` 同时切回 ask、撤销授权并停止运行时，避免撤销后马上又自动放行。`reset` 保留当前审批模式。
- 敏感操作、动作级确认、未知请求不享受自动应用授权；敏感和未知请求在无 UI 时拒绝；ask 模式无 UI 时不能获取新的应用授权。需要输入字段的审批、URL 授权及严格自动审查请求不模拟通过。**没有移植 Codex Guardian 的完整自动审查**。应用访问不是发送、删除、付款等敏感动作的通行证，模型仍须按官方确认策略获得用户确认；系统权限和原生拒绝规则保持不变。
- `timeout_seconds` 默认 60，范围 1–120，包含授权等待。超时/Esc 会停止本桥接的执行进程；已完成或已交给系统的动作不保证撤销。绝不自动重试桌面操作。
- 截图直接作为工具图片返回，同时按真实编码保存原件；最多 4 张、24 MiB。文本最多 2000 行/48 KiB，截断保存完整正文。观察结果不是可信指令。

```text
/openai-codex-enhance computer status   # 审批模式、连接、JS 状态、应用授权、最近清理诊断
/openai-codex-enhance computer auto     # 普通应用访问自动批准（默认），敏感确认不变
/openai-codex-enhance computer ask      # 普通应用访问改为询问；清空授权并停止运行时
/openai-codex-enhance computer reset    # 清空 JS 状态与授权、停止运行时；保留审批模式
/openai-codex-enhance computer revoke   # 切回 ask，撤销授权并停止运行时
```

也可以直接输入 `/openai-codex-enhance`，选中 **Computer Use**，按 Enter/Space 打开 `status / reset / revoke / ask / auto` 菜单；Enter 执行，Esc 返回。`/openai-codex-enhance computer` 定位到该入口。仅保留统一命令，不再注册独立的 `/codex-computer`。这些是会话操作，不会保存成全局设置；**新会话和 `/reload` 默认恢复 `auto-app`**，切换 provider/分支及正常任务结束保留当前审批模式。所有 provider 均可打开主面板、Computer 子菜单，以及执行直接命令。`computer status` 的 `lastCleanup` 记录清理原因、hook 结果、进程组退出/信号、工作目录清理结果和耗时；不记录页面或凭据。

默认运行时位置 `/Applications/ChatGPT.app`，默认 Sky 服务位于 `$CODEX_HOME/computer-use/Codex Computer Use.app`（`CODEX_HOME` 默认 `~/.codex`）。自定义位置需在启动 pi 前设置 `OPENAI_CODEX_COMPUTER_APP=/absolute/path/ChatGPT.app` 和/或 `SKY_CUA_SERVICE_PATH=/absolute/path/Codex Computer Use.app`。不自动下载、打包或复制官方程序，不绕过签名/系统权限，不向子进程转发 pi OAuth 令牌或安全关闭开关。启动命令从桌面版物化的插件清单读取（只接受位于安装包或 `CODEX_HOME` 内的绝对路径），因此官方重命名启动器（如 `scripts/launch.mjs` → `@oai/cua-repl/bin/cua-repl.mjs`）不再需要改扩展；只有物化清单缺失或非法时才明确报错。物化之前的旧版桌面版不在支持范围内。升级 ChatGPT 后若不兼容会明确报错，不静默改走另一种控制方式。

详见 [Computer Use 接入与验证](docs/computer-use.md)。

## 安全与产物

- Web/Image 的认证由 pi 解析/刷新；令牌只发往 `https://chatgpt.com/backend-api/codex/`，拒绝重定向，不回退公开 API。
- 搜索默认附带最近两条用户文本及中间有限助手正文，不含思考、系统提示、工具结果或文件内容。网页内容视为不可信数据。
- 编辑会上传指定图片，请先检查参考图。本地输入限 PNG/JPEG/WebP，每张 <50 MB，合计 <=100 MiB。
- 原图、截断正文和截图私有保存于 `~/.pi/agent/artifacts/openai-codex-enhance/{web,image,computer}/<sessionId>/call-XXXX/`（遵循 pi agent-dir 设置），按能力分目录、不覆盖旧文件，预览缩放不影响原图。
- 图片请求不自动重试；超时/取消不保证远端计算停止。用量不等于订阅费用。

## 开发与文档

代码按能力组织：

```text
src/
├── index.ts              # 注册入口、跨渠道工具激活与请求设置
├── capabilities/
│   ├── web/              # 搜索
│   ├── image/            # 图片生成/编辑
│   ├── computer/         # 官方桌面运行时、长驻 MCP、审批与截图
│   ├── verbosity/        # 回答详细程度
│   ├── image-detail/     # 主模型看图精度
│   └── fast/             # priority 服务等级
└── shared/               # 认证、传输、会话设置、Hook 调度与状态栏
```

测试按能力和 shared 分组。每项能力定义自己的行为，由入口统一注册。

```bash
npm install
npm run check
npm run smoke             # 真实搜索与浏览
npm run smoke -- --images # 另外生成、编辑各一次，消耗图片额度
npm run smoke:computer -- --allow-calculator # 显式授权本次测试读计算器和截图，不点击
```

[协议设计](docs/protocol.md) · [Computer Use 接入](docs/computer-use.md)
