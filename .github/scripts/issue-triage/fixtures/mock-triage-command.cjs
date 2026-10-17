// Copied as `gh` / `codex` into a private test PATH. No real network or auth.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const settings = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const send = (value) => process.stdout.write(JSON.stringify(value));

if (command === 'codex' && args[0] === '--version') {
  console.log(settings.version || 'codex-cli 0.156.1');
} else {
  const input = args.includes('--input') || args.includes('--body-file') || command === 'codex'
    ? fs.readFileSync(0, 'utf8') : '';
  const call = { command, args, input };
  if (command === 'codex') {
    call.env = process.env;
    call.cwd = process.cwd();
    call.config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    call.schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
  } else {
    call.githubToken = process.env.GH_TOKEN;
  }
  fs.appendFileSync(path.join(root, 'calls.jsonl'), `${JSON.stringify(call)}\n`);
  if (command === 'codex') {
    const output = args[args.indexOf('--output-last-message') + 1];
    if (!settings.missingResponse) fs.writeFileSync(output, settings.response);
    console.log('{"type":"progress","message":"This is not the final answer"}');
    if (settings.failCodex) {
      console.error('model diagnostic with sensitive-data-canary');
      process.exit(1);
    }
    if (settings.modelDelay) setTimeout(() => {}, settings.modelDelay);
  } else if (args[0] === 'issue' && args[1] === 'view') {
    send(settings.issue);
  } else if (args[0] === 'issue' && args[1] === 'list') {
    send(settings.candidates);
  } else if (args[0] === 'issue' && args[1] === 'comment') {
    if (settings.failComment) process.exit(1);
    send({});
  } else if (args[0] === 'issue' && args[1] === 'edit') {
    send({});
  } else if (args[0] === 'api' && args[1].endsWith('/comments')) {
    if (settings.failCommentRead) process.exit(1);
    process.stdout.write(settings.trustedComments || '');
  } else if (args[0] === 'api' && args[1] === 'graphql') {
    const query = args.find((a) => a.startsWith('query=')) || input;
    if (query.includes('mutation')) {
      if (settings.failTypeWrite && query.includes('updateIssue')) process.exit(1);
      if (settings.failFieldWrite && query.includes('setIssueFieldValue')) process.exit(1);
      send({ data: {} });
    } else if (query.includes('repository(')) {
      send({ data: { repository: settings.context } });
    } else {
      send({ data: { node: settings.freshIssue || settings.context.issue } });
    }
  } else {
    console.error('Unexpected fake gh call:', args);
    process.exit(1);
  }
}
