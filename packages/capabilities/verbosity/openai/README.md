# verbosity / openai

- Capability: `verbosity`
- Provider: `openai`
- Kind: `request-control`
- Install: `/pi-enhance openai verbosity install`
- Load: `/pi-enhance openai verbosity load --save`
- Parameters: `src/schema.ts` (tools) or `src/control.ts` (request controls).
- Authentication: supplied by the host; no credential files are read here.
- Validation: repository `npm run check`, including protocol and contract tests.
