// OAuth session profile for MCP connectors. A connector calls createOAuthConnector with its config
// (loadOAuthConfig), a brand, optional consent wording and `tools`, which returns the MCP sources
// (perRequestSource / sharedSource / perInvocationSource) behind the resource server.
export { createOAuthConnector } from './connector.mjs';
export { loadOAuthConfig, DEFAULTS } from './config.mjs';
export { perRequestSource, sharedSource, perInvocationSource, protectedResourceMetadata } from './resource-server.mjs';
export { consentService, genericAccess } from './consent.mjs';
export { SCOPES } from './authorization-server.mjs';
export { DEFAULT_BRAND, brandOf } from './brand.mjs';
export { CHATGPT_CLIENT_ID } from './clients.mjs';
