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
  'daemon-first target', 'daemon-first guide route', 'daemon-first experimental target',
  'unparsed frontend target', 'required target missing from frontend',
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
      // The daemon catalog leads: a new section's row lands in intentd before
      // cloudlands-fe registers it (intentd#3617 waited on cloudlands-fe#4901).
      const newSection = { id: 'new-section', tab: 'input', hashAliases: ['new-section'], scrollSelector: '#new-section', highlightSelector: '[data-highlight-id="new-section"]', label: 'Settings: New section', route: '/settings?tab=input#new-section', description: 'A section the frontend has not registered yet.' };
      if (scenario.startsWith('daemon-first')) rows.push(scenario === 'daemon-first experimental target' ? { ...newSection, id: 'developer' } : newSection);
      if (scenario === 'daemon-first guide route') write(guide, `${readFileSync(path.join(root, guide), 'utf8')}\nOpen \`${newSection.route}\`.\n`);
      if (scenario === 'unparsed frontend target') write(frontend, readFileSync(path.join(root, frontend), 'utf8').replace("  settingsTarget({\n    id: 'devices',", "  otherTarget({\n    id: 'devices',"));
      if (scenario === 'required target missing from frontend') write(frontend, readFileSync(path.join(root, frontend), 'utf8').replace("id: 'new-workspace'", "id: 'renamed-workspace'"));
      if (['changed route', 'lost alias', 'experimental recommendation', 'duplicate target', 'missing documented target'].includes(scenario) || scenario.startsWith('daemon-first')) write(catalog, JSON.stringify(rows));
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-app-ui-targets.mjs'), '--root', fixture], { encoding: 'utf8' });
      const ok = ['current components', 'legacy daemon', 'daemon-first target', 'daemon-first guide route'].includes(scenario);
      assert.equal(result.status, ok ? 0 : 1, result.stdout + result.stderr);
      if (scenario === 'legacy daemon') assert.match(result.stdout, /legacy.*not yet adopted/i);
      if (scenario === 'current components') assert.doesNotMatch(result.stdout, /::warning::/);
      if (scenario === 'daemon-first target' || scenario === 'daemon-first guide route') {
        assert.match(result.stdout, /^::warning::app-ui-targets: new-section: no frontend registry entry yet/m);
        assert.match(result.stdout, /plus 1 pending frontend/);
      }
      if (scenario === 'daemon-first experimental target') assert.match(result.stderr, /developer: experimental/);
      if (scenario === 'unparsed frontend target') assert.match(result.stderr, /devices: frontend names this target but the checker cannot parse it/);
      if (scenario === 'required target missing from frontend') assert.match(result.stderr, /new-workspace: no frontend registry entry for a required destination/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
