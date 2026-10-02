import metadata from "../../package.json" with { type: "json" };
export const clientInfo = { name: "agent-enhance", version: metadata.version };
export const userAgent = `${clientInfo.name}/${clientInfo.version}`;
