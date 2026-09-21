# search_web / openai

- Capability: `search_web`
- Provider: `openai`
- Kind: `tool`
- Install: `/pi-enhance openai search_web install`
- Load: `/pi-enhance openai search_web load --save`
- Parameters: `src/schema.ts` (tools) or `src/control.ts` (request controls).
- Authentication: supplied by the host; no credential files are read here.
- Validation: repository `npm run check`, including protocol and contract tests.
