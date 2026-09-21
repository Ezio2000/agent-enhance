# Release and rollback

## Build

1. `npm ci --ignore-scripts`
2. `npm run check` (strict types, dependency boundaries, reproducible bundles, automated tests, offline minimal-tarball verification)
3. Commit source and `dist/modules/*.mjs` together.
4. Set the immutable module revision with `MODULE_REVISION=<that-commit> npm run build`.
5. Commit the catalog / Pi bundle update. The referenced revision must contain byte-identical module files.
6. Run `npm run verify:distribution -- --download`: it unpacks the actual npm tarball and runs a fresh Pi SDK process with an empty isolated home. Only the two explicitly enabled image modules are downloaded from the pinned public HTTPS source. It checks zero-capability startup, selective enable/disable, schema merging, idempotence and uninstall retention without model calls or user credentials. The default `npm run verify:distribution` performs the same checks using a mocked HTTPS transport with local build fixtures, and makes no network calls.
7. Run `npm pack --dry-run --ignore-scripts` and confirm the Pi tarball excludes `dist/modules`, capability source code and standalone `dist/core.mjs`.
8. Merge the tested commits into the existing repository's main branch, without force pushing.
9. If npm distribution is desired, confirm package ownership/name availability and the release version, then explicitly publish the verified package. Publishing is a separate maintainer action, not part of build/check. Only after publishing advertise `pi install npm:pi-enhance`; Git/local installation remains supported.

`dist/core.mjs` is a standalone base artifact. The root package is the `pi-enhance` host distribution; `packages/core/package.json` documents the host-neutral package boundary. No npm publishing is required for Git/local installation.

## Local replacement

Back up Pi settings first. Keep the source directories and old artifacts. Register only one Agent Enhance package source and remove duplicate package entries. Do not remove unrelated extensions. Restart Pi or use its native `/reload` in existing sessions.

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
