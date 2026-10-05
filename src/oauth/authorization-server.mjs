import { authorizationServer as base, transactionCookie as cookie } from 'mcp-connector-kit/oauth/authorization-server';
import { T3_BRAND } from './brand.mjs';
export * from 'mcp-connector-kit/oauth/authorization-server';
export const transactionCookie = (issuer, brand = T3_BRAND) => cookie(issuer, brand);
export const authorizationServer = opts => base({ brand: T3_BRAND, ...opts });
