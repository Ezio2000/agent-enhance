# Release and rollback

## Build

1. `npm ci --ignore-scripts`
2. `npm run check` (strict types, dependency boundaries, reproducible bundles, automated tests)
3. Commit source and `dist/modules/*.mjs` together.
4. Set the immutable module revision with `MODULE_REVISION=<that-commit> npm run build`.
5. Commit the catalog / Pi bundle update. The referenced revision must contain byte-identical module files.
6. Run `npm run verify:distribution -- --download`: it downloads both image backends without a local source and tests remote install/load from the minimal tarball in a fresh Pi process.
7. Run `npm pack --dry-run` and confirm the Pi tarball excludes `dist/modules`.
8. Merge the tested commits into the existing repository's main branch, without force pushing.

`dist/core.mjs` is a standalone base artifact. The root package is the `pi-enhance` host distribution; `packages/core/package.json` documents the host-neutral package boundary. No npm publishing is required for Git/local installation.

## Local replacement

Back up Pi settings first. Keep the source directories and old artifacts. Register only the new local repository or the updated remote package; remove old grok-enhance and muse-enhance entries and any duplicate old Codex extension entry. Do not remove unrelated extensions. Restart Pi or use its native `/reload` in existing sessions.

Run `/pi-enhance migrate` to import unset request preferences. Use explicit install/load commands for the capabilities to retain, and save defaults for ambiguous tools such as `gen_image`. Neither migration nor installation copies API keys or OAuth credentials.

The optional `npm run setup -- --all` development helper runs those same commands through a real Pi SDK session, installing and saving all 10 modules, preserving preexisting control preferences. It does not invoke cloud models.

## Trial

`npm run smoke -- --live --images --video --computer` uses the **currently installed** Pi extension and real host authentication. It sends only generated fixtures, creates two images and one short video, queries search, views a PDF and a synthetic clip, and performs a read-only native desktop observation. It may consume quota. No paid request is retried automatically. Results remain under ignored `artifacts/smoke/`.

The desktop probe never clicks, types, sends, deletes, purchases, or changes permissions. It verifies cleanup of the bridge-owned process group. If upstream auth, quota or runtime prerequisites block a capability, record that as a failed/blocked trial rather than claiming success.

## Rollback

Restore the backed-up Pi package list and reload Pi. Existing source projects, old artifacts and host credentials remain untouched. Request preferences for the new package live under `~/.agent-enhance/hosts/pi.json`; desktop approvals are not persisted. New module files and artifacts can remain without affecting the old installation.
