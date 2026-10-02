# gen_image / xai

- Capability: `gen_image`
- Provider: `xai`
- Availability: discovered automatically from a matching xai service connection.
- Parameters: `src/schema.ts` (tools) or `src/control.ts` (request controls).
- Authentication: supplied by the host; no credential files are read here.
- Validation: repository `npm run check`, including protocol and contract tests.
