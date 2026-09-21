# view_pdf / opencode

- Capability: `view_pdf`
- Provider: `opencode`
- Kind: `tool`
- Install: `/pi-enhance opencode view_pdf install`
- Load: `/pi-enhance opencode view_pdf load --save`
- Parameters: `src/schema.ts` (tools) or `src/control.ts` (request controls).
- Authentication: supplied by the host; no credential files are read here.
- Validation: repository `npm run check`, including protocol and contract tests.
