# Architecture

## Dependency direction

`hosts -> integrations/services -> core/contracts + core/registry`; capability modules depend on Core contracts and their transport. Core never imports hosts, discovery, configuration readers or transports. `npm run check:boundaries` enforces these boundaries. The Claude Code adapter does not import the Pi SDK.

Service discovery is an integration policy. An SDK caller can bypass it and directly inject modules, preferences for explicit bindings, and a `CredentialResolver` into Core. The standalone Core bundle and each capability module are self-contained ESM artifacts.

## Service discovery

A `ServiceSource` reads local metadata and returns stable `ServiceConnection` IDs, provider/channel/kind, source labels and a source-bound credential resolver. `discoverServices` isolates errors by source. Discovery does not refresh OAuth, execute configured Key commands, call a model, or start desktop processes. Connection availability means local prerequisites exist; remote quota and authorization are determined on execution.

The Pi source inspects current stored credential metadata, environment and JSONC models configuration. It uses the native registry only for runtime/extension configuration, avoiding stale stored-auth snapshots after external edits. Execution delegates to `getProviderAuth`; externally changed model configuration is refreshed locally on execution, not discovery. Configured Key commands run only when credentials are actually needed.

File sources cover Codex, Pi, OpenCode, Agent Enhance's original credential store and named environment variables. Domestic/global MiniMax and ZAI identities stay distinct. No credential import or copied OAuth store is created. Refresh re-reads under the source's lock and writes to that original file, preserving unrelated entries. Pi OAuth uses Pi-compatible proper-lockfile locking. Plain API keys can include environment interpolation and command-backed values.

A local runtime source discovers the ChatGPT application without launching it. Full Computer Use prerequisites are checked on execution.

## Capability derivation and synchronization

`ServiceRuntime` matches catalog requirements to discovered connections, host features, platform, model input and optional exclusions. Each applicable module/connection pair becomes an explicit Core binding. Synchronization is serialized. A source error retains its last known connections and reports the error; a successful empty discovery removes them. This avoids treating temporary source-read failures as logout.

Unwanted bindings are suspended immediately, so existing tool handles cannot start new calls. Busy instances finish their current calls; hosts synchronize again after settlement and dispose them. Genuine cleanup errors are reported separately from busy calls. Tool state and discovery snapshots are memory-only.

Preferences are host-scoped under `preferences/<host>.json`. Only preferred service IDs and exclusions are shared fields. Pi owns request settings and subagent settings. Atomic writes and locks protect concurrent writers. No project-level configuration is read.

## Core and parameter composition

Core owns module contracts, schema validation, explicit binding selection and lifecycle. It knows nothing about credential files, environment discovery or automatic activation. A binding provides its stable ID, label and resolver. Each call captures the selected resolver; refreshing bindings does not redirect an in-flight call.

Each capability exports one definition with its identity, label, group and parameter-composition policy. Module identity is derived from that definition and provider. The execution contract is module API v2, and the bundled catalog format is v2; mismatched contracts are rejected. Images and web-search composition policies live in their capability directories, not Core. Provider-specific arguments are namespaced under `options.<provider>` and revalidated against the selected provider schema.

Routing uses an explicit `service`, a `provider` narrowing the candidates, an applicable saved preference, or the sole candidate. Ambiguity is an error. An explicit provider can override an unrelated preference; an explicit service never falls back. Failed calls never retry on another connection. Tool schemas sort connections deterministically and expose only active bindings. Removed or suspended handles fail as stale.

Factories must be inert: no network or process startup. Instances own lifecycle and disposal. Core's request-control pipeline is generic; Pi defines its Codex-specific transformations and scope checks.

## Distribution

Every release includes the Pi adapter, generated module catalog and all tool-module bundles. Claude Code runs its self-contained adapter and those same modules from the plugin checkout. Catalog identity and constraints come from module exports; labels come from capability definitions. Version comes from the root package. No independent installation records, download pins or module update commands exist.

Host upgrades and module upgrades happen together. Imports and factories are lazy; expensive work begins only during execution. Historical artifacts are independent of code distribution.

## Host integration

Pi preserves its native active-tool exclusions while schemas change. Newly available tools join the active set; an existing tool manually removed from it stays inactive. Session/model changes feed explicit conditions into synchronization. Credentials, history, previews, UI and host lifecycle are bridged by Pi. File watchers observe original sources and preferences, including atomic replacements and source-directory creation.

Request settings are bundled with Pi and default to no override. Footer values are model/API-scoped. Subagents remain an explicit, default-off host feature using independent SDK sessions; they use the parent's active supported tool allowlist and available/scoped models. Disabling cancels current batches. Shutdown, session and branch changes preserve cancellation and cleanup semantics; completion notifications stay session-bound.

Claude Code has one MCP server per session. Source/preferences changes emit `tools/list_changed`; listing tools also reconciles current local state. Core-bound resolvers supply authentication during execution. Session sockets and prompt/stop hooks bridge transcript history, notices and task settlement. Unknown main-model modalities keep vision tools exposed. MCP elicitation continues to handle Computer Use choices.

Desktop grants and JS state remain per-session and memory-only. Runtime cleanup is tied to task settlement and host shutdown; failures do not replay operations.
