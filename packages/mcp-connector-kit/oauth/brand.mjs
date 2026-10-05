// What a deployment calls itself on the pages, cookies, protected-resource metadata and new
// passkeys. Each connector passes its own; changing it later renames cookies (open sign-ins restart)
// but does not invalidate enrolled passkeys, which are bound to the rpID and credential id.
export const DEFAULT_BRAND = Object.freeze({ name: 'MCP Connector', cookie: 'mcpc', passkeyUser: 'mcp-connector-oauth' });
export const brandOf = brand => ({ ...DEFAULT_BRAND, ...(brand ?? {}) });
