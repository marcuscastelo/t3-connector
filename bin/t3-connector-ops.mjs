#!/usr/bin/env node
// Operator CLI over src/ops.mjs: thread operations in any configured T3 environment with the
// operator's own token (no passkey lease). Output is JSON on stdout; errors are JSON on stderr
// with exit 1 (operation failed or refused) or 2 (usage).
//
//   t3-connector-ops environments
//   t3-connector-ops <env> list
//   t3-connector-ops <env> thread <threadId>
//   t3-connector-ops <env> read <threadId> [--since P] [--last N]
//   t3-connector-ops <env> timeline <threadId> [--message-ids ID,ID] [--not-before ISO]
//   t3-connector-ops <env> projects
//   t3-connector-ops <env> providers
//   t3-connector-ops <env> send <threadId> --message-id ID [--delivery queue_after_active|start_immediately] < text
//   t3-connector-ops <env> create --project P --title T --instance I --model M [--effort E] [--option id=value]...
//                                 [--runtime-mode M] [--worktree BASE[:BRANCH]] --client-request-id ID < brief
//   t3-connector-ops <env> settle <threadId>...
//   t3-connector-ops <env> snooze <threadId> <ISO datetime with offset>
//
// <env> is an alias, an extra alias or an environmentId from the ops config (src/ops.mjs).

import { readFileSync } from 'node:fs';
import { createOps, loadOpsConfig, OpsError, resolveEnvironment } from '../src/ops.mjs';

const USAGE = 'usage: t3-connector-ops environments | <env> list|thread|read|timeline|projects|providers|send|create|settle|snooze … (see the header of bin/t3-connector-ops.mjs)';
const out = (v) => process.stdout.write(JSON.stringify(v, null, 1) + '\n');
const usage = (m) => { throw new OpsError('usage', m ?? USAGE); };

function parse(args) {
  const positional = [], flags = {}, options = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const name = args[i].slice(2), value = args[++i];
    if (value === undefined) usage(`--${name} needs a value`);
    if (name === 'option') options.push(value); else flags[name] = value;
  }
  return { positional, flags, options };
}
const int = (v, name, min) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) usage(`--${name} must be an integer >= ${min}`);
  return n;
};
const stdin = () => readFileSync(0, 'utf8');
const option = (s) => {
  const i = s.indexOf('=');
  if (i < 1) usage(`--option ${s}: use id=value`);
  const v = s.slice(i + 1);
  return { id: s.slice(0, i), value: v === 'true' ? true : v === 'false' ? false : v };
};

async function main() {
  const [first, command, ...rest] = process.argv.slice(2);
  if (first === '--version') return out(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  const config = await loadOpsConfig();
  if (first === 'environments') return out(config.environments.map(({ alias, aliases, environmentId }) => ({ alias, aliases, environmentId })));
  if (!first || !command) usage();
  const ops = createOps(resolveEnvironment(config.environments, first));
  const { positional: [id, ...ids], flags, options } = parse(rest);
  try {
    switch (command) {
      case 'list': return out(await ops.list());
      case 'thread': return out(await ops.thread(id ?? usage('thread needs <threadId>')));
      case 'read': return out(await ops.read(id ?? usage('read needs <threadId>'), { since: int(flags.since, 'since', 0), last: int(flags.last, 'last', 1) }));
      case 'timeline': return out(await ops.timeline(id ?? usage('timeline needs <threadId>'), { messageIds: flags['message-ids']?.split(',').filter(Boolean) ?? [], notBefore: flags['not-before'] ? Date.parse(flags['not-before']) : 0 }));
      case 'projects': return out(await ops.projects());
      case 'providers': return out(await ops.providers());
      case 'send': return out(await ops.send(id ?? usage('send needs <threadId>'), { text: stdin(), messageId: flags['message-id'], delivery: flags.delivery }));
      case 'create': {
        const worktree = flags.worktree?.split(':');
        return out(await ops.create({ project: flags.project ?? usage('create needs --project'), title: flags.title, instanceId: flags.instance, model: flags.model,
          effort: flags.effort, options: options.map(option), runtimeMode: flags['runtime-mode'], clientRequestId: flags['client-request-id'],
          workspace: worktree ? { type: 'worktree', baseRef: worktree[0], ...(worktree[1] ? { branch: worktree[1] } : {}), startFromOrigin: false } : { type: 'root' },
          text: process.stdin.isTTY ? '' : stdin() }));
      }
      case 'settle': { const r = await ops.settle([id, ...ids].filter(Boolean)); out(r); if (!r.length || r.some((x) => !x.ok)) process.exitCode = 1; return; }
      case 'snooze': {
        const until = new Date(ids[0] ?? usage('snooze needs <threadId> <ISO>'));
        if (Number.isNaN(until.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(ids[0])) usage('snooze date must be ISO with offset');
        const r = await ops.snooze(id, until); out(r); if (!r.ok) process.exitCode = 1; return;
      }
      default: usage();
    }
  } finally { ops.close(); }
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ error: e.code ?? 'failed', message: e.message, ...(e.details && Object.keys(e.details).length ? { details: e.details } : {}) }) + '\n');
  process.exit(e.code === 'usage' ? 2 : 1);
});
