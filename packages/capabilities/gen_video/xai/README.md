# gen_video / xai

- Capability: `gen_video`
- Provider: `xai`
- Kind: `tool`
- Install: `/pi-enhance xai gen_video install`
- Load: `/pi-enhance xai gen_video load --save`
- Parameters: `src/schema.ts` (tools) or `src/control.ts` (request controls).
- Authentication: supplied by the host; no credential files are read here.
- Validation: repository `npm run check`, including protocol and contract tests.
