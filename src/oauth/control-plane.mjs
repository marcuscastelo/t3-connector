import { controlPlane as base } from 'mcp-connector-kit/oauth/control-plane';
import { T3_BRAND } from './brand.mjs';
export * from 'mcp-connector-kit/oauth/control-plane';
export const controlPlane = opts => base({ brand: T3_BRAND, ...opts });
