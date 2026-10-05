import { publicLogin as base } from 'mcp-connector-kit/oauth/public-login';
import { T3_BRAND } from './brand.mjs';
export * from 'mcp-connector-kit/oauth/public-login';
export const publicLogin = opts => base({ brand: T3_BRAND, ...opts });
