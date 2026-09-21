# gen_image / xai

- Capability: `gen_image`
- Provider: `xai`
- Kind: `tool`
- Install: `/pi-enhance xai gen_image install`
- Load: `/pi-enhance xai gen_image load --save`
- Parameters: `src/schema.ts` (tools) or `src/control.ts` (request controls).
- Authentication: supplied by the host; no credential files are read here.
- Validation: repository `npm run check`, including protocol and contract tests.
