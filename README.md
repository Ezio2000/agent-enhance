# Agent Enhance

宿主无关的 AI 额外能力基座，当前提供 **Pi 专属适配包 `pi-enhance`**。由 grok-enhance、muse-enhance、openai-codex-enhance 重构而来。非供应商官方项目；真实调用可能消耗订阅／API 额度并上传显式输入文件。

## 架构

- `packages/core`：能力契约、注册合并、路由、认证接口、配置与模块管理；不依赖 Pi。
- `packages/capabilities/<功能>/<供应商>`：纯功能实现，不读 Agent 的凭据文件，不注册宿主工具。
- `packages/transports/<供应商>`：协议、认证目标地址校验及跨功能辅助代码。
- `packages/hosts/pi`：Pi 工具、命令、登录态解析、UI 与生命周期桥接。
- `dist/core.mjs`：可脱离 Pi 导入的自包含基座。未来宿主只需实现契约；**当前没有声称支持 Claude Code**。

供应商 ID 为 `openai`、`xai`、`opencode`。Codex／Go 是渠道，Grok／Muse 是模型，不作为供应商目录。

## 安装与迁移

需要 Node.js >=22、Pi >=0.86.1 的兼容扩展 API。

```bash
pi install https://github.com/Ezio2000/agent-enhance
```

GitHub 仓库为 `Ezio2000/agent-enhance`，Pi 集成包名为 `pi-enhance`。后续更新执行 `pi update https://github.com/Ezio2000/agent-enhance`。

若之前从旧仓库 URL 安装，先安装新地址，再移除旧来源（使用 `pi list` 显示的来源字符串）：

```bash
pi remove https://github.com/Ezio2000/openai-codex-enhance
```

移除单独安装的 grok-enhance、muse-enhance 等来源，并重启 Pi 或执行 `/reload`。不要同时加载其他 `pi-enhance` 来源；同一工具的冲突会在加载时明确报错。能力及偏好保存在 `~/.agent-enhance`，切换安装来源不移动认证或历史产物。

新安装默认**不加载任何能力**，不会启动桌面进程或调用模型。按需安装：

```text
/pi-enhance catalog
/pi-enhance openai gen_image install
/pi-enhance openai gen_image load --save
/pi-enhance xai gen_image install
/pi-enhance xai gen_image load --save
/pi-enhance defaults gen_image openai
/pi-enhance status
```

`install` 安装能力模块，不下载云端模型权重，也不自动加载。`load` 仅当前会话生效；`load --save` 保存为 Pi 自动加载偏好。`unload --save` 同时移除自动加载；`uninstall` 移除安装记录，保留历史产物及可能被其他进程使用的内容寻址缓存。

模块是独立、自包含的 ESM 文件。安装从本地仓库构建产物或目录中锁定的 Git commit 下载，校验 SHA-256 与长度后提交；**不会隐式回退到其他模型、供应商或登录态**。发布 tarball 只含适配器与目录，不含全部能力；Git 安装本身会克隆完整仓库，模块仍须显式安装与加载。

## 能力与工具

| 工具／能力 ID  | 供应商      | 说明                                |
| -------------- | ----------- | ----------------------------------- |
| `gen_image`    | openai、xai | 图片生成／编辑；只注册一个工具      |
| `gen_video`    | xai         | 视频生成                            |
| `view_pdf`     | opencode    | Muse Spark 查看本地 PDF             |
| `view_video`   | opencode    | Muse Spark 查看本地视频；不支持音频 |
| `search_web`   | openai      | 搜索、浏览、图片查询、天气／金融等  |
| `use_computer` | openai      | macOS 原生 Computer Use             |
| `fast`         | openai      | 请求增强，不注册工具                |
| `verbosity`    | openai      | 请求增强，不注册工具                |
| `image_detail` | openai      | 请求增强，不注册工具                |

工具名使用下划线，不带供应商。两个图片模块同时加载时仍只有一个 `gen_image`；卸载某供应商后，其参数会从 Schema 消失。最后一个实现卸载后，工具从活动工具集移除。宿主的工具排除规则仍然有效。

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

图像原件与视频保存后返回路径，预览不替代原件。生成请求不自动重试；超时不保证远端运算停止。Web 引用原始 URL，网页和屏幕内容都是不可信数据。

## 请求增强

先安装并加载相应模块：

```text
/pi-enhance openai fast install
/pi-enhance openai fast load --save
/pi-enhance openai fast on
/pi-enhance openai verbosity high
/pi-enhance openai image_detail on
```

最后两项也要求事先安装／加载对应模块。`fast` 设置 `service_tier=priority`，可能增加额度消耗；`verbosity` 控制回答详细程度；`image_detail on` 对应 `original`，不关闭宿主图片缩放。`off` 表示不覆盖原请求。仅作用于支持的 OpenAI Codex 主模型请求，不影响独立工具。

`/pi-enhance` 打开选择面板；`/pi-enhance openai fast` 打开设置选择器，选中即保存并返回，Esc 取消不改值。状态栏仅在当前主模型为受支持的 OpenAI Codex Responses 模型时显示各控制当前值，切到其他模型即隐藏。提供命令参数补全及标准 Pi 状态栏，不替换整个 Footer。非交互模式须提供显式操作或值。

## 认证

基座只认识 `CredentialResolver` 与 `(provider, channel, acceptedKinds)`。Pi 实现委托 `modelRegistry.getProviderAuth()` 获取／刷新认证，不自行扫描或复制认证文件。

| 能力渠道       | Pi 认证来源  | 接受类型   |
| -------------- | ------------ | ---------- |
| openai / codex | openai-codex | 订阅 OAuth |
| xai / imagine  | xai          | OAuth      |
| opencode / go  | opencode-go  | API Key    |

使用 Pi 原生 `/login` 配置对应渠道。平台 OpenAI API Key 不能替代 Codex OAuth。将来其他 Agent 自行实现获取方式与登录引导；现有 `StaticCredentialResolver` 可用于显式配置的独立宿主和测试。凭据只发送至相应供应商的固定受限地址，日志脱敏，拒绝认证请求重定向。

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

本版只使用宿主级配置，不自动读取项目级配置。配置原子写入并使用跨进程写锁；损坏配置不会被默认值覆盖。`status` 检查已加载云能力的认证可用性，不执行计费请求；实际模型额度与后端权限仍须调用验证。

## 开发与验收

```bash
npm ci --ignore-scripts
npm run check
npm run smoke                         # 仅打印用法，不发起付费请求
npm run smoke -- --live               # search + PDF；上传合成测试文件
npm run smoke -- --live --images      # 两个供应商各生成一张图
npm run smoke -- --live --video       # 合成参考图生成短视频，并交给 Muse 查看
npm run smoke -- --live --computer    # 仅读取桌面应用列表，清理私有运行时
```

测试包含迁移的协议／运行时回归、参数合并、认证隔离、安装完整性、Pi 真实 SDK 注册／卸载、宿主工具排除规则。真实 smoke 使用现有 Pi 登录态，只发送合成测试内容，记录本地产物，不上传验收结果到仓库。

详见 [架构](docs/architecture.md)、[发布与回滚](docs/release.md)。
