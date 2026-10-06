#!/usr/bin/env node
// Narrow, compilation-free check of Assistant destinations against the frontend
// registry. Read source as data; never execute code from an upstream PR checkout.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { root: { type: 'string' } } });
const root = path.resolve(values.root ?? here);
const read = file => readFileSync(path.join(root, file), 'utf8');
const resource = 'packages/intentd/crates/intent-acp/resources/app-ui-targets.json';

function mappedTargets(source) {
  const groups = [...source.matchAll(/\.\.\.\[([\s\S]*?)\]\.map\(\(\[id, label, description, tab\]\) =>\s*settingsTarget\(\{([\s\S]*?)\}\),\s*\),/g)];
  assert.equal(groups.length, 1, 'expected one settings tuple map; review changed registry format');
  const [, literals, template] = groups[0];
  const expectedTemplate = 'id, tab, hashAliases: [id], scrollSelector: `#${id}`, highlightSelector: `[data-highlight-id="${id}"]`, label: `Settings: ${label}`, route: `/settings?tab=${tab}#${id}`, description,';
  assert.equal(template.replace(/\s/g, ''), expectedTemplate.replace(/\s/g, ''), 'settings map formula changed; review the contract parser');
  // Accept only nested arrays of single-quoted strings. Convert string tokens
  // to JSON, then let JSON.parse reject expressions, calls and other TS syntax.
  const json = literals.replace(/'((?:[^'\\]|\\['\\])*)'/g, (_, value) => JSON.stringify(value.replace(/\\(['\\])/g, '$1')));
  const tuples = JSON.parse(`[${json}]`.replace(/,\s*\]/g, ']'));
  return new Map(tuples.map(tuple => {
    assert.ok(Array.isArray(tuple) && tuple.length === 4 && tuple.every(value => typeof value === 'string'), 'invalid settings tuple');
    const [id, label, description, tab] = tuple;
    return [id, { id, tab, hashAliases: [id], scrollSelector: `#${id}`, highlightSelector: `[data-highlight-id="${id}"]`, label: `Settings: ${label}`, route: `/settings?tab=${tab}#${id}`, description }];
  }));
}

try {
  const binding = read('packages/intentd/crates/intent-acp/src/mcp_server/bindings/app/ui.rs');
  if (!existsSync(path.join(root, resource))) {
    // Permit only the known pre-adoption implementation, not a missing-file
    // escape hatch after adoption. Monorepo can land before the daemon change.
    const legacy = readFileSync(path.join(here, 'scripts/fixtures/app-ui-targets/legacy-targets.rs.txt'), 'utf8').trim();
    const implementation = binding.match(/fn targets\(\)[\s\S]*?(?=\/\/\/ Normalize a required|$)/)?.[0].trim();
    assert.equal(implementation, legacy, 'missing catalog on a non-legacy daemon');
    console.log('::warning::app-ui-targets: legacy daemon; catalog contract not yet adopted');
  } else {
    assert.match(binding, /serde_json::from_str\(include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/resources\/app-ui-targets\.json"\)\)/, 'catalog must be wired into targets()');
    const rows = JSON.parse(read(resource));
    assert.ok(Array.isArray(rows) && rows.length > 0, 'catalog must be a nonempty array');
    const source = read('packages/cloudlands-fe/src/shared/app-ui-targets.ts');
    const blocks = [...source.matchAll(/^  (?:settingsTarget\()?\{\n([\s\S]*?)^  \}/gm)].map(m => m[1]);
    const mapped = mappedTargets(source);
    const ids = new Set();
    const required = ['new-workspace', 'utility-default-model', 'global-instructions', 'devices', 'websocket-api', 'workspace-card'];
    for (const row of rows) {
      assert.equal(typeof row.id, 'string', 'target id must be a string');
      assert.ok(!ids.has(row.id), `duplicate target ${row.id}`);
      ids.add(row.id);
      assert.ok(!['guest-sessions', 'developer', 'agent-features'].includes(row.id), `${row.id}: experimental/internal destinations must not be routine recommendations`);
      const block = blocks.find(b => b.match(/^    id: '([^']+)',/m)?.[1] === row.id);
      const mappedRow = mapped.get(row.id);
      assert.ok(block || mappedRow, `${row.id}: no frontend registry entry; extend the checker deliberately for a new registry format`);
      for (const field of ['id', 'tab', 'route', 'scrollSelector', 'highlightSelector', 'dynamic', 'idPattern']) {
        const match = block?.match(new RegExp(`^    ${field}: (.*),$`, 'm'));
        let expected = mappedRow?.[field];
        if (match) {
          assert.ok(/^'(?:[^'\\]|\\.)*'$|^(true|false)$/.test(match[1]), `${row.id}.${field}: unsupported registry expression`);
          expected = match[1] === 'true' ? true : match[1] === 'false' ? false : match[1].slice(1, -1).replace(/\\'/g, "'");
        }
        assert.deepEqual(row[field], expected, `${row.id}.${field} differs from frontend registry`);
      }
      const aliases = block?.match(/hashAliases: \[([\s\S]*?)\]/)?.[1];
      const expectedAliases = aliases === undefined ? mappedRow?.hashAliases : [...aliases.matchAll(/'([^']+)'/g)].map(m => m[1]);
      assert.deepEqual(row.hashAliases, expectedAliases, `${row.id}.hashAliases differs from frontend registry`);
      assert.equal(typeof row.label, 'string', `${row.id}: missing label`);
      assert.equal(typeof row.description, 'string', `${row.id}: missing description`);
    }
    for (const id of required) assert.ok(ids.has(id), `missing supported destination ${id}`);
    const guide = read('packages/intentd/crates/intent-services/resources/assistant-app-guide.md').replace(/<!--[\s\S]*?-->/g, '');
    const guideRoutes = [...new Set([...guide.matchAll(/`(\/[^`\s]+)`/g)].map(match => match[1]).filter(route => !/[{}]/.test(route)))];
    assert.ok(guideRoutes.length > 0, 'guide must document static navigation routes');
    for (const route of guideRoutes) {
      // Every catalog row has already been checked against the frontend; this
      // makes guide → catalog → registry a single enforced route contract.
      assert.ok(rows.some(row => row.route === route), `guide route missing from supported catalog: ${route}`);
    }
    const remote = rows.find(row => row.id === 'websocket-api');
    assert.match(remote.description, /QR/i, 'Remote Access must describe QR pairing');
    assert.match(remote.description, /mobile/i, 'Remote Access must be discoverable for mobile questions');
    console.log(`app-ui-targets: ${rows.length} supported destinations and ${guideRoutes.length} guide routes match frontend routes, aliases and selectors`);
  }
} catch (error) {
  console.error(`app-ui-targets: ${error.message}`);
  process.exitCode = 1;
}
