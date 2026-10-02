# Agent Enhance

宿主无关的 AI 能力基座，提供 Pi 适配包 `pi-enhance` 与 Claude Code 插件 `cc-enhance`。安装后自动发现已有服务连接，提供对应工具。服务商发现位于独立集成层；Core 可作为独立 SDK 使用。

## 安装和更新

需要 Node.js >=22、Pi >=0.86.1。

```bash
pi install https://github.com/Ezio2000/agent-enhance
# 更新后，在运行中的 Pi 执行 /reload
pi update https://github.com/Ezio2000/agent-enhance
```

Claude Code：

```bash
claude plugin marketplace add Ezio2000/agent-enhance
claude plugin install cc-enhance@agent-enhance
# 更新后 /reload-plugins 或开启新会话
claude plugin marketplace update agent-enhance
claude plugin update cc-enhance@agent-enhance
```

日常安装和更新使用 Git 远端，避免把开发工作树注册为持久包来源。所有能力代码随同一版本分发，工具按需创建实例，云请求和桌面运行时仅在实际执行时启动。更新宿主即更新能力。

## 服务商发现

```text
宿主认证与本地配置 → 服务商发现 → 服务连接 → 可用能力 → Core → 宿主工具
```

Pi 直接使用原生认证来源，也发现 Codex、OpenCode 和 Agent Enhance 已有凭据；Claude Code 发现 Codex、Pi、OpenCode、Agent Enhance 和环境变量来源。发现阶段只读取本地状态，不刷新 OAuth、不执行 Key 命令、不调用模型。文件变化会重新推导工具；`refresh` 可主动重检。

| 服务商         | 渠道                     | 发现来源                                                                |
| -------------- | ------------------------ | ----------------------------------------------------------------------- |
| OpenAI         | Codex OAuth              | Pi `openai-codex`、`$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`） |
| xAI            | Imagine OAuth            | Pi `xai`、已有 Agent Enhance 原始凭据                                   |
| OpenCode       | Go API Key               | Pi `opencode-go`、OpenCode `auth.json`、`OPENCODE_API_KEY`              |
| MiniMax        | Token Plan API Key       | Pi `minimax-cn` / `minimax`、`MINIMAX_CN_API_KEY` / `MINIMAX_API_KEY`   |
| ZAI            | Coding Plan API Key      | Pi `zai` / `zai-coding-cn`、`ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY`     |
| ChatGPT 桌面版 | 本地 Computer Use 运行时 | macOS 上的应用位置；完整运行条件在首次执行时检查                        |

Pi 凭据默认位于 `~/.pi/agent/auth.json`，可由 `PI_CODING_AGENT_DIR` 改变。OpenCode 来源是 `$XDG_DATA_HOME/opencode/auth.json`（默认 `~/.local/share/opencode/auth.json`），或 `OPENCODE_AUTH_CONTENT`。已有 `~/.agent-enhance/credentials.json` 继续作为独立原始来源读取，不再从其它来源导入副本。

连接 ID 对应稳定来源，例如 `pi:minimax-cn`、`pi:minimax`、`codex:openai-codex`、`env:ZAI_API_KEY`。同一服务商的不同站点和来源可同时存在。执行绑定所选连接，OAuth 刷新写回原来源；Pi 来源使用它的刷新锁协议。

没有凭据时，先在原应用登录（Pi `/login`、`codex login` 等）或设置相应环境变量。有匹配凭据会自动提供能力；凭据存在不保证额度和实际服务权限。平台 OpenAI / xAI API Key 不会被当成对应订阅 OAuth。

## 服务与偏好

Pi 打开 `/pi-enhance` 面板；Claude Code 使用 `/cc-enhance`。两宿主共享以下命令语义：

```text
/pi-enhance services
/pi-enhance status
/pi-enhance refresh
/pi-enhance prefer gen_image pi:xai
/pi-enhance prefer gen_image auto
/pi-enhance exclude gen_image
/pi-enhance include gen_image
/pi-enhance exclude gen_image pi:openai-codex
```

Claude Code 将前缀换为 `/cc-enhance`。`services` 列出连接；`status` 区分可用、缺少连接、已排除、宿主不支持、模型已支持该输入、加载失败和正在退出的调用。

只有一个符合请求的连接时自动选择；多个连接时由 Agent 在参数中选择 `provider` 或精确 `service`，也可以保存偏好。同一供应商有多个连接时，仅指定 `provider` 仍不足以选择账号。显式连接不可用时直接报错，失败不会自动换连接重发。

排除项可针对整个能力或一个能力的特定连接。排除立即阻止新调用，已有调用完成后释放实例。Pi 原生工具排除规则仍然有效。`view_image` 在主模型已经支持图片时隐藏；Claude Code 无法取得主模型信息，因此保持提供。

## 工具

| 工具                      | 服务商               | 用途                                        |
| ------------------------- | -------------------- | ------------------------------------------- |
| `gen_image`               | openai、xai、minimax | 图片生成；OpenAI / xAI 支持编辑             |
| `gen_video`               | xai                  | 视频生成                                    |
| `gen_voice`               | minimax              | 语音合成                                    |
| `search_web`              | openai、zai          | 联网搜索和网页阅读；OpenAI 提供更多查询命令 |
| `view_pdf` / `view_video` | opencode             | 本地 PDF / 视频理解                         |
| `view_image`              | zai                  | 图片与视觉任务                              |
| `use_computer`            | openai 本地运行时    | macOS 原生应用操作                          |

同一能力的供应商合并为一个工具。公共字段位于顶层，专属字段位于 `options.<provider>`；合并规则由对应能力定义负责。

```json
{
  "provider": "xai",
  "service": "pi:xai",
  "prompt": "一个蓝色圆形图标，白色背景",
  "options": { "xai": { "aspect_ratio": "1:1", "resolution": "1k", "quality": "low" } }
}
```

原始媒体保存在产物目录，预览不替代原件。生成请求不自动重试，超时不保证远端运算停止。

## Pi 请求设置与子代理

请求设置直接可用，无需安装能力模块。默认不覆盖原请求：

```text
/pi-enhance fast on
/pi-enhance verbosity high
/pi-enhance image_detail original
```

`off` 取消覆盖。仅作用于支持的 Codex 主模型请求；Fast 请求 priority tier，可能增加额度消耗。`image_detail original` 不关闭宿主图片缩放。Footer 只在支持的主模型上显示相应设置。Claude Code 不支持请求拦截，因此没有这些设置。

子代理是 Pi 宿主功能，默认关闭：

```text
/pi-enhance subagents enable
/pi-enhance subagents model minimax-cn/MiniMax-M2.7
/pi-enhance subagents model inherit
/pi-enhance subagents status
/pi-enhance subagents cancel <batch-id>
/pi-enhance subagents disable
```

启用后提供 `call_subagents`、`view_subagent_models`、`view_subagents`、`cancel_subagents`。每个子任务用独立 Pi SDK AgentSession 执行；父历史不自动复制，工具只能来自父会话当前活跃的受支持工具。任务指定模型优先于宿主默认值，否则继承当前模型；模型不可用时明确报错。跨批次最多同时运行 4 个任务，每批最多 8 个。禁用、退出或切换会话取消批次；当前会话只保留最近 24 个完成批次。写入和桌面操作等工具继续遵循批次审批。

## Computer Use

仅 macOS。需要兼容 ChatGPT 桌面版及已物化的官方 Computer Use 插件，并满足本地登录、辅助功能及屏幕录制要求。发现应用后提供工具，首次执行检查完整条件并延迟启动运行时。

```text
/pi-enhance computer status
/pi-enhance computer ask
/pi-enhance computer revoke
```

Claude Code 使用 `/cc-enhance computer ...` 或 `manage_computer` 工具。首次工具调用使用 `await cua.getState()` 或 `await cua.getApp('bundle.id')`，读取返回 API 后继续。任务结束清理私有运行时；授权和 JS 状态不跨会话共享。长任务可在 Claude Code 设置 `MCP_TOOL_TIMEOUT=600000`。

## 配置和 SDK

默认根目录 `~/.agent-enhance`，可由 `AGENT_ENHANCE_HOME` 改变。无需偏好时不会生成配置文件：

```text
preferences/pi.json
preferences/claude-code.json
credentials.json                    # 可选的原始凭据来源
artifacts/<host>/<capability>/<provider>/<session>/<call>/
```

通用偏好只有 `preferred` 和 `excluded`；Pi 另有 `requests`、`subagents`。配置采用原子写入和写锁，损坏文件不会被默认值覆盖。服务连接、工具可用性及运行状态都从当前来源推导，不持久化。

`packages/core` 只负责执行契约、参数组合、显式路由与生命周期，不读取认证文件或偏好，不依赖发现层。独立调用方直接注入模块、凭据解析器及可选连接绑定；`dist/core.mjs` 和各能力 bundle 可在没有 Pi 和 node_modules 的目录使用。

## 开发与验证

```bash
npm ci --ignore-scripts
npm run check
npm run verify:distribution
npm run smoke                  # 只打印用法，不调用服务
npm run smoke -- --live         # 显式真实验收，可能消耗额度
```

完整检查包含类型、格式、依赖边界、协议回归、发现与刷新、Pi SDK、Claude Code MCP、独立 SDK 和离线打包验收。发布流程见 [release](docs/release.md)，职责边界见 [architecture](docs/architecture.md)。
