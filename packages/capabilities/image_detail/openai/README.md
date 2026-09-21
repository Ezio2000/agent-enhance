# image_detail / openai

- Capability: `image_detail`
- Provider: `openai`
- Kind: `request-control`
- Install: `/pi-enhance openai image_detail install`
- Load: `/pi-enhance openai image_detail load --save`
- Parameters: `src/schema.ts` (tools) or `src/control.ts` (request controls).
- Authentication: supplied by the host; no credential files are read here.
- Validation: repository `npm run check`, including protocol and contract tests.
