import { protectedResourceMetadata as metadata, resourceServer as base } from 'mcp-connector-kit/oauth/resource-server';
import { T3_BRAND } from './brand.mjs';
export * from 'mcp-connector-kit/oauth/resource-server';
export const protectedResourceMetadata = opts => metadata({ name: T3_BRAND.name, ...opts });
export const resourceServer = opts => base({ brand: T3_BRAND, serverInfo: { name: 't3-connector', version: '0.0.0' }, ...opts });
