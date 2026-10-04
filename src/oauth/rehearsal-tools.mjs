import { z } from 'zod';

// Harmless tools for the local rehearsal mode: they exercise the OAuth session end to end (read and
// write scopes, activity, revocation) without any backend. The "write" only appends to an in-memory
// list that disappears when the process exits.
export function rehearsalTools() {
  const notes = [];
  return function registerTools(server, principal) {
    const tag = principal.sid.slice(0, 6);
    server.registerTool('rehearsal_now', { title: 'Server time (rehearsal)', description: 'Rehearsal tool with no data behind it: returns the server time.', inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: 'text', text: `server time ${new Date().toISOString()} (session ${tag})` }] }));
    server.registerTool('rehearsal_echo', { title: 'Echo (rehearsal)', description: 'Rehearsal tool: echoes the given text back.', inputSchema: { text: z.string().max(200) }, annotations: { readOnlyHint: true } },
      async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
    server.registerTool('rehearsal_notes', { title: 'List notes (rehearsal)', description: 'Rehearsal tool: lists the notes written in this process.', inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: 'text', text: JSON.stringify(notes) }] }));
    server.registerTool('rehearsal_note_write', { title: 'Write a note (rehearsal)', description: 'Rehearsal write tool: appends a short note to an in-memory list. No external effect.', inputSchema: { text: z.string().min(1).max(200) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
      async ({ text }) => { notes.push({ at: new Date().toISOString(), session: tag, text }); return { content: [{ type: 'text', text: `note ${notes.length} saved` }] }; });
  };
}
