// The T3 Connector's OAuth session profile: the generic composition from mcp-connector-kit with the
// T3 names and consent wording. T3 tool catalogs are passed by the caller (src/oauth/t3-tools.mjs).
import { createOAuthConnector as base } from 'mcp-connector-kit/oauth/connector';
import { T3_BRAND } from './brand.mjs';
import { t3Access } from './consent.mjs';
export * from 'mcp-connector-kit/oauth/connector';
export const createOAuthConnector = opts => base({ brand: T3_BRAND, describeAccess: t3Access, ...opts });
