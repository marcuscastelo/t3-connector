// Moved to mcp-connector-kit; the write gate keeps its T3 names for new passkeys.
import { Passkeys as Base } from 'mcp-connector-kit/oauth/webauthn';
export class Passkeys extends Base {
  constructor(options) { super({ rpName: 'T3 Connector', userName: 't3-connector', ...options }); }
}
