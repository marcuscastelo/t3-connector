import { parseResourceCapture as parse } from 'mcp-connector-kit/oauth/resource-capture';
export * from 'mcp-connector-kit/oauth/resource-capture';
export const parseResourceCapture = (env, prefix = 'T3_CONNECTOR_OAUTH') => parse(env, prefix);
