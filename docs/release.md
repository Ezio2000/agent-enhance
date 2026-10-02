# Release and rollback

## Build and verify

1. Run `npm ci --ignore-scripts` and `npm run check`.
2. Confirm source, adapters, catalog, standalone Core and every capability bundle were rebuilt together. One root package version identifies the release.
3. Run `npm pack --dry-run --ignore-scripts`. The Pi package must include every `dist/modules/*.mjs` named in the catalog and exclude sources/node_modules. `npm run verify:distribution` runs an unpacked release in a fresh, isolated Pi SDK process with synthetic credentials and network requests disabled.
4. When a release is authorized, commit source and all generated `dist` changes together, then push without rewriting remote history. Review CI before updating installed packages. Build/check does not publish or install anything.

## Pi

Normal installation and updates use the Git remote:

```bash
pi install https://github.com/Ezio2000/agent-enhance
pi update https://github.com/Ezio2000/agent-enhance
```

Run `/reload` in existing sessions to use the new adapter and bundled modules. Discovery reuses existing credentials and automatically derives tools. No second module update step is needed. Development trials may explicitly load the local bundle in an isolated session; do not register the working tree as a persistent Pi package source.

## Claude Code

The plugin runs `dist/cc-enhance.mjs` from its checkout. Validate the plugin and, when installation/update is authorized, use:

```bash
claude plugin marketplace update agent-enhance
claude plugin update cc-enhance@agent-enhance
```

Use `/reload-plugins` or a new session for new code. Local source and preference changes update tools live within the current release. Updating code still requires reloading the host.

## Preferences and sources

This release uses `preferences/pi.json` and `preferences/claude-code.json`. Only explicit service preferences and exclusions are persisted; Pi additionally stores request and subagent settings. Installation/automatic-loading configuration from earlier releases is no longer read. To retain an intentional setting, apply the corresponding new command, such as `prefer gen_image pi:xai`, `fast on` or `subagents model <provider/id>`. No dual-format runtime or old-command aliases are retained.

Original credentials and artifact directories remain independent of the host upgrade. Existing Agent Enhance credentials remain a supported original discovery source. No automatic cleanup touches original credentials, other agent settings, historical media or previously created cache files.

## Live trial

`npm run smoke -- --live --images --video --computer` uses the currently installed Pi extension and existing authentication, sends synthetic fixtures, and may consume quota. Only run paid or desktop trials when explicitly requested. Offline `npm run check` does not invoke models or activate desktop software.

## Rollback

Install an earlier authorized host release and reload that host. Keep source credential stores and historical artifacts. Preference schemas belong to their release; desktop grants are never restored from disk. Npm publication remains a separate maintainer operation.
