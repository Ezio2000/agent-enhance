# view_video / opencode

- Capability: `view_video`
- Provider: `opencode`
- Kind: `tool`
- Install: `/pi-enhance opencode view_video install`
- Load: `/pi-enhance opencode view_video load --save`
- Parameters: `src/schema.ts` (tools) or `src/control.ts` (request controls).
- Authentication: supplied by the host; no credential files are read here.
- Validation: repository `npm run check`, including protocol and contract tests.
