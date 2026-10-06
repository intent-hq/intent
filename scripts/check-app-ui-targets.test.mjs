import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const binding = 'packages/intentd/crates/intent-acp/src/mcp_server/bindings/app/ui.rs';
const catalog = 'packages/intentd/crates/intent-acp/resources/app-ui-targets.json';
const frontend = 'packages/cloudlands-fe/src/shared/app-ui-targets.ts';
const guide = 'packages/intentd/crates/intent-services/resources/assistant-app-guide.md';

// Exercise the real checker CLI across independently updated component trees.
// Mutations model drift, not a second copy of the expected catalog.
for (const scenario of [
  'current components', 'legacy daemon', 'changed route', 'lost alias',
  'missing catalog', 'unwired catalog', 'experimental recommendation', 'duplicate target',
  'moved guide route', 'missing documented target', 'moved mapped target', 'changed map formula',
]) {
  test(scenario, () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'app-ui-contract-'));
    const write = (file, text) => {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      writeFileSync(path.join(fixture, file), text);
    };
    try {
      for (const file of [binding, catalog, frontend, guide]) write(file, readFileSync(path.join(root, file), 'utf8'));
      const rows = JSON.parse(readFileSync(path.join(fixture, catalog), 'utf8'));
      if (scenario === 'legacy daemon') {
        write(binding, readFileSync(path.join(root, 'scripts/fixtures/app-ui-targets/legacy-targets.rs.txt'), 'utf8'));
        rmSync(path.join(fixture, catalog));
      }
      if (scenario === 'changed route') rows.find(t => t.id === 'devices').route = '/settings?tab=wrong#devices';
      if (scenario === 'lost alias') rows.find(t => t.id === 'devices').hashAliases = ['devices'];
      if (scenario === 'missing catalog') rmSync(path.join(fixture, catalog));
      if (scenario === 'unwired catalog') write(binding, 'fn targets() -> Value { json!([]) }');
      if (scenario === 'experimental recommendation') rows.push({ id: 'guest-sessions', tab: 'collaboration', route: '/settings?tab=collaboration#collaboration' });
      if (scenario === 'duplicate target') rows.push(rows[0]);
      if (scenario === 'moved guide route') write(guide, readFileSync(path.join(root, guide), 'utf8').replace('/settings?tab=display#theme', '/settings?tab=display#missing-theme'));
      if (scenario === 'missing documented target') rows.splice(rows.findIndex(t => t.id === 'notifications'), 1);
      if (scenario === 'moved mapped target') write(frontend, readFileSync(path.join(root, frontend), 'utf8').replace("'Notification preferences.', 'app-behavior'", "'Notification preferences.', 'advanced'"));
      if (scenario === 'changed map formula') write(frontend, readFileSync(path.join(root, frontend), 'utf8').replace('route: `/settings?tab=${tab}#${id}`', 'route: `/settings?tab=wrong#${id}`'));
      if (['changed route', 'lost alias', 'experimental recommendation', 'duplicate target', 'missing documented target'].includes(scenario)) write(catalog, JSON.stringify(rows));
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-app-ui-targets.mjs'), '--root', fixture], { encoding: 'utf8' });
      const ok = ['current components', 'legacy daemon'].includes(scenario);
      assert.equal(result.status, ok ? 0 : 1, result.stdout + result.stderr);
      if (scenario === 'legacy daemon') assert.match(result.stdout, /legacy.*not yet adopted/i);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
