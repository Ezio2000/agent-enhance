# Release and rollback

## Build

1. `npm ci --ignore-scripts`
2. `npm run check` (strict types, dependency boundaries, reproducible bundles, automated tests, offline minimal-tarball verification)
3. Commit source and `dist/modules/*.mjs` together.
4. Set the immutable module revision with `MODULE_REVISION=<that-commit> npm run build`.
5. Commit the catalog / Pi bundle update. The referenced revision must contain byte-identical module files.
6. After confirming the remote branch has not moved, push both commits to the Git remote without force pushing. `npm run verify:distribution -- --download` then fetches modules from the pinned **public** commit and runs a fresh Pi SDK process with an empty isolated home. Only the two explicitly enabled image modules are downloaded; no model calls or user credentials are used. The default `npm run verify:distribution` uses mocked HTTPS and local fixtures instead.
7. Run `npm pack --dry-run --ignore-scripts` and confirm the Pi tarball excludes `dist/modules`, capability source code and standalone `dist/core.mjs`. Check CI on the pushed commits; if remote verification fails, fix and publish a new commit rather than rewriting history.
8. For the normal Pi installation, use only the Git remote source: `pi install https://github.com/Ezio2000/agent-enhance` (once) or `pi update https://github.com/Ezio2000/agent-enhance`. In an existing Pi session run `/reload`, `/pi-enhance update --installed`, then `/reload` again. The host update does not silently update capability modules.
9. If npm distribution is desired, confirm package ownership/name availability and the release version, then explicitly publish the verified package. Publishing is a separate maintainer action, not part of build/check. Only after publishing advertise `pi install npm:pi-enhance`. Local package loading remains a development/trial option, not the standard installed source.

`dist/core.mjs` is a standalone base artifact. The root package is the `pi-enhance` host distribution; `packages/core/package.json` documents the host-neutral package boundary. No npm publishing is required for Git/local installation.

## Development trials and source migration

Do not persistently install a local working tree for normal use: uncommitted `dist` changes and the Git release catalog can diverge. Use an explicit `pi -ne -e /absolute/path/to/agent-enhance/dist/pi-enhance.mjs` for an isolated trial instead. When switching an existing installation back to the Git remote, back up Pi settings first, install the remote source, remove the local source identified by `pi list`, and verify only one `pi-enhance` remains. Keep the source directories and old artifacts. Do not remove unrelated extensions. Restart Pi or use its native `/reload` in existing sessions.

Use explicit install/load commands for the capabilities to retain, and save defaults for ambiguous tools such as `gen_image`. Installation does not copy API keys or OAuth credentials.

The optional `npm run setup -- --all` development helper runs those same commands through a real Pi SDK session, installing and saving all catalog modules, preserving preexisting control preferences. It does not invoke cloud models. This all-modules development helper is not the normal selective-install entrypoint.

## Module maintenance

Use `/pi-enhance <provider> <capability> enable` for install-if-missing + saved loading; `disable` removes autoload but retains installation/control preferences. Existing install/load/unload commands remain compatible. `enable` refuses to silently upgrade an already installed module whose hash differs from the current host catalog.

After updating the main Pi package, reload it to receive the new catalog. `/pi-enhance updates` only compares that local catalog against installed hashes. `/pi-enhance update --installed` updates only installed entries; `/pi-enhance <provider> <capability> update` selects one. The batch installation-record commit is atomic, failures retain prior records and preferences, and current in-memory instances are not replaced. Explicitly load previously unloaded modules afterwards, or reload Pi to restore saved autoload. New catalog entries are never installed automatically.

Staging and installation records are separate from host preferences. If enable's load/save step fails, the verified installation may remain, but no new autoload preference is saved. Disable/uninstall attempts to restore preferences and registration on ordinary failures; a runtime that was already disposed is recreated lazily, not resumed with old desktop grants. Recovery errors are reported rather than hidden. A process crash across config/runtime steps is not a multi-file transaction.

## Trial

`npm run smoke -- --live --images --video --computer` uses the **currently installed** Pi extension and real host authentication. It sends only generated fixtures, creates two images and one short video, queries search, views a PDF and a synthetic clip, and performs a read-only native desktop observation. It may consume quota. No paid request is retried automatically. Results remain under ignored `artifacts/smoke/`.

The desktop probe never clicks, types, sends, deletes, purchases, or changes permissions. It verifies cleanup of the bridge-owned process group. If upstream auth, quota or runtime prerequisites block a capability, record that as a failed/blocked trial rather than claiming success.

## Rollback

Restore the backed-up Pi package list and reload Pi. Existing source projects, old artifacts and host credentials remain untouched. Request preferences for the new package live under `~/.agent-enhance/hosts/pi.json`; desktop approvals are not persisted. New module files and artifacts can remain without affecting the old installation.
