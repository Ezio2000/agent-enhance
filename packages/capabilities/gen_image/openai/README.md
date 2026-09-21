# gen_image / openai

- Capability: `gen_image`
- Provider: `openai`
- Kind: `tool`
- Install: `/pi-enhance openai gen_image install`
- Load: `/pi-enhance openai gen_image load --save`
- Parameters: `src/schema.ts` (tools) or `src/control.ts` (request controls).
- Authentication: supplied by the host; no credential files are read here.
- Validation: repository `npm run check`, including protocol and contract tests.
