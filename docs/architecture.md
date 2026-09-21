# Architecture

## Dependency direction

`hosts/pi -> core/contracts` and `capabilities/<function>/<provider> -> core/contracts + transports/<provider>`. No Pi SDK imports are allowed outside the host adapter. `npm run check:boundaries` enforces this. The standalone `dist/core.mjs` and each module bundle can load outside the repository without Pi or node_modules.

A module exports one `CapabilityModule` with an API-versioned `manifest` and a `create(services)` factory. Factories must not start processes or perform network requests. Background resources start lazily on execution and implement disposal. Providers do not register host tools themselves.

## Authentication

`CredentialResolver.resolve({provider, channel, acceptedKinds}, {signal, interactive})` is implemented by each host. It returns a discriminated ready/missing/login_required/unsupported result. Pi delegates to its own model registry, retaining native refresh locking. The explicit standalone resolver does not search agent files. OAuth and API keys are not interchangeable; Codex OAuth is never sent to public API endpoints. Credential refresh does not authorize retrying a generation request.

The protocol still sends `originator: pi` for the verified Codex wire channel; it is a compatibility header, not an import or dependency on the Pi runtime. New channels require independently verified protocols, not automatic credential fallback.

## Tool merging

`CapabilityRegistry` groups loaded implementations by capability ID. A single top-level object schema exposes the loaded provider enum. `gen_image` shares prompt/model/reference/timeout fields and namespaces divergent options under `options.openai` and `options.xai`; `search_web` shares the `search_query`/`open` commands and namespaces provider-only commands and parameters the same way. The shared-field sets live in a per-capability policy map in the registry; capabilities without an entry treat every field as common. All other current capabilities have only one implementation and retain their established function arguments plus provider selection. Adding another implementation must define semantic common fields before merging incompatible schemas; identical spelling is not sufficient proof of compatibility.

Routing is explicit provider, saved per-capability default, or sole loaded provider. The main agent model never selects a tool backend. Missing or ambiguous selection is an error. Arguments are checked against the merged schema and then against the selected implementation's original schema. Models, image counts, dimensions and semantic constraints are validated again by the implementation. In-flight calls keep their chosen implementation; unloading busy modules is refused. Old host-held definitions cannot call an unloaded module.

A manifest may declare `modelInputExcludes` (e.g. `["image"]`): hosts keep such tools unregistered while the active model already accepts that input modality, and re-synchronize on model changes. This availability rule is derived from the host model, not a user disable, and follows the same registration path as load/unload; `view_image/zai` uses it so multimodal models never see a redundant vision tool.

## Installation

`dist/catalog.json` contains manifests, byte lengths, SHA-256 hashes and an immutable source revision. Modules are self-contained ESM bundles, including their TypeBox runtime; they do not need npm lifecycle scripts. Installation downloads/copies exactly the selected module (or reuses verified cached bytes), verifies it, atomically writes a content-addressed file and updates the lock. Load never downloads. `enable` composes explicit install-if-missing, load and saved autoload; it never silently updates an existing installation or changes request-control values. A failed load/save may leave a verified installation but does not add autoload. Uninstall removes the logical installation record; content-addressed files are retained because other processes can still use them. Historical artifacts are never removed.

The minimal Pi distribution excludes module bundles; the Git checkout necessarily includes all repository files. Per-module installation and loading remain explicit for both formats. Updating the host catalog does not execute a new module automatically: mismatched hashes require explicitly updating/reinstalling the selected module. `updates` is an offline comparison against the current host catalog, not a remote latest-version check. `update --installed` stages only installed modules with changed hashes and commits all selected installation records in one atomic write. If download, integrity verification, cancellation or lock acquisition fails, old records remain unchanged. Compare-and-swap checks reject concurrent changes to selected installations while preserving unrelated writers. Staged content-addressed files can remain for an explicit retry. Updating does not import module code or replace live instances; new code takes effect on a subsequent load. Old cache retention does not imply cross-host-version compatibility.

## Host integration

The Pi adapter compiles neutral tool results to Pi definitions, delegates credentials, filters transcript history into text-only messages, and maps task/session/provider events. Tool/lifecycle bridging stays in `hosts/pi/src/index.ts`; management commands and feature-first selection dialogs live in `management.ts`. The panel exposes module size, platform/auth requirements and independent installed/loaded/autoload states. Status also reports authentication and host tool availability. Request controls use the existing custom Footer. Management commands are serialized, wait for the host to become idle, and downloads are cancelled on session shutdown. Disable/uninstall reject busy modules before changing preferences, and attempt recovery of autoload/registration on later failures; desktop runtime state and grants are never restored from disk. Pi's tool allowlist/exclusions stay authoritative. Model changes do not reactivate disabled tools.

Computer Use receives approvals and task-settled callbacks. Ordinary app access is not sensitive-action authorization. JS state survives low-level automatic continuation and ends at task settlement; host session shutdown, branch changes, provider changes and unloading reset grants and runtime state. Runtime cancellation never replays side effects.

Request controls are data + pure transforms. They are active only for supported provider/channel/API/model contexts. Their preferences are distinct from proof that a backend honored the requested setting.

## Future hosts

A Claude Code adapter may expose the tools through MCP plus a host plugin for additional lifecycle/approval features. It must supply its own credential strategy and map supported lifecycle events. Request interception, live schema refresh, approval UI and task completion are not assumed universally available. Unsupported capabilities must be disabled explicitly; no Claude Code support is claimed by this release.

## State

`AGENT_ENHANCE_HOME` controls the base directory. Installed files can be shared; host configuration is namespaced. Credentials stay in the host credential store. Desktop permissions and runtime state are memory-only per host session. This release does not read project-level configuration, avoiding untrusted project-driven module loading.
