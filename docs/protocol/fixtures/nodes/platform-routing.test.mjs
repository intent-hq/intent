// Prepared static contract checks only. No real scheduler, database transaction,
// node admission, native worker, transport, authority or cleanup is executed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';

const bytes = s => Buffer.byteLength(s, 'utf8');
const own = (o, k) => Object.hasOwn(o, k);
function object(o, required, optional = []) {
  assert.ok(o && typeof o === 'object' && !Array.isArray(o));
  for (const k of required) assert.ok(own(o, k), `missing ${k}`);
  for (const k of Object.keys(o)) assert.ok([...required, ...optional].includes(k), `unknown ${k}`);
}
function str(s, max) { assert.equal(typeof s, 'string'); assert.ok(bytes(s) > 0 && bytes(s) <= max); assert.ok(!/[\u0000-\u001f\u007f]/u.test(s)); }
function int(n, max) { assert.ok(Number.isSafeInteger(n) && n >= 1 && n <= max); }
function one(v, values) { assert.ok(values.includes(v), `invalid enum ${v}`); }
// Retain decoded key identity before JSON.parse could erase duplicate members.
export function parseUnique(raw) {
  const tokens = raw.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g) || [];
  let i = 0;
  function value() {
    const t = tokens[i++];
    if (t === '{') {
      const keys = new Set();
      if (tokens[i] === '}') { i++; return; }
      do {
        if (tokens[i] === ',') i++;
        const key = JSON.parse(tokens[i++]); assert.equal(typeof key, 'string');
        assert.ok(!keys.has(key), `duplicate ${key}`); keys.add(key);
        assert.equal(tokens[i++], ':'); value();
      } while (tokens[i] === ',');
      assert.equal(tokens[i++], '}');
    } else if (t === '[') {
      if (tokens[i] === ']') { i++; return; }
      do { if (tokens[i] === ',') i++; value(); } while (tokens[i] === ',');
      assert.equal(tokens[i++], ']');
    } else { assert.notEqual(t, undefined); JSON.parse(t); }
  }
  value(); assert.equal(i, tokens.length);
  return JSON.parse(raw); // Also reject invalid characters, whitespace and trailing syntax.
}
export function placement(p) {
  object(p, [], ['os', 'arch', 'target', 'checkout', 'nodeId', 'exclusive']);
  if (own(p, 'os')) one(p.os, ['linux', 'macos']);
  if (own(p, 'arch')) one(p.arch, ['x86_64', 'aarch64']);
  if (own(p, 'target')) one(p.target, ['local', 'remote']);
  if (own(p, 'checkout')) one(p.checkout, ['shared', 'worktree', 'isolated']);
  if (own(p, 'nodeId')) str(p.nodeId, 128);
  if (own(p, 'exclusive')) assert.equal(typeof p.exclusive, 'boolean');
  if (p.target === 'remote') assert.equal(p.checkout ?? 'isolated', 'isolated');
  if (p.exclusive) { assert.notEqual(p.target, 'local'); assert.equal(p.checkout ?? 'isolated', 'isolated'); }
  return p;
}
export function capacity(c) {
  object(c, ['nodeId','name','os','arch','maxAgents','reservedAgents','memoryBudgetBytes','usedMemoryBytes','agentMemoryBytes','ready','exclusiveReserved']);
  str(c.nodeId,128);str(c.name,128);placement({os:c.os,arch:c.arch});
  int(c.maxAgents,1024); int(c.memoryBudgetBytes,2**50);int(c.agentMemoryBytes,c.memoryBudgetBytes);
  assert.ok(Number.isSafeInteger(c.reservedAgents) && c.reservedAgents >= 0 && c.reservedAgents <= c.maxAgents);
  assert.ok(Number.isSafeInteger(c.usedMemoryBytes) && c.usedMemoryBytes >= 0 && c.usedMemoryBytes <= c.memoryBudgetBytes);
  assert.equal(typeof c.ready,'boolean');assert.equal(typeof c.exclusiveReserved,'boolean');
  return c;
}
function pairs(a) {
  assert.ok(Array.isArray(a) && a.length <= 1);
  const keys = a.map(p => { object(p, ['os', 'arch']); placement(p); return `${p.os}/${p.arch}`; });
  assert.deepEqual(keys, [...new Set(keys)].sort()); return keys;
}
export function unavailable(e) {
  object(e, ['code', 'message', 'data']); assert.equal(e.code, -32602); str(e.message, 4096);
  const d = e.data;
  object(d, ['code', 'requested', 'reason', 'availablePlatforms', 'supportedPlatforms', 'availableOs', 'retryable', 'observedAt']);
  assert.equal(d.code, 'placement-unavailable'); object(d.requested, [], ['os', 'arch']); placement(d.requested);
  one(d.reason, ['unsupported-platform', 'no-capacity']);
  const available = pairs(d.availablePlatforms), supported = pairs(d.supportedPlatforms);
  assert.ok(available.every(p => supported.includes(p)));
  assert.deepEqual(d.availableOs, [...new Set(d.availablePlatforms.map(p => p.os))].sort());
  const match = p => (!d.requested.os || p.os === d.requested.os) && (!d.requested.arch || p.arch === d.requested.arch);
  assert.equal(d.availablePlatforms.some(match), false);
  assert.equal(d.supportedPlatforms.some(match), d.reason === 'no-capacity');
  assert.equal(d.retryable, d.reason === 'no-capacity');
  assert.match(d.observedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(Number.isFinite(Date.parse(d.observedAt)));
}
// Pure fixture classification only; not production authority or atomic admission.
function classify(c,p) {
  capacity(c);placement(p);
  if ((p.os && p.os !== c.os) || (p.arch && p.arch !== c.arch) || (p.nodeId && p.nodeId !== c.nodeId)) return 'unsupported-platform';
  if (!c.ready || c.reservedAgents >= c.maxAgents || c.exclusiveReserved ||
      c.usedMemoryBytes + c.agentMemoryBytes > c.memoryBudgetBytes || (p.exclusive && c.reservedAgents !== 0)) return 'no-capacity';
  return 'eligible';
}
const corpus = parseUnique(readFileSync(new URL('./platform-routing.json', import.meta.url), 'utf8'));
test('corpus declares static scope and unique case identities', () => {
  assert.equal(corpus.qualification, 'prepared-static-only'); assert.equal(corpus.publicVersion, '11.2');
  assert.deepEqual(corpus.capability, { agentPlatformRouting: 1 });
  const ids = [...corpus.placementCases, ...corpus.matchingCases, ...corpus.runtimeScenarios].map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(corpus.runtimeScenarios.every(c => c.executed === false && c.requires.length));
});
for (const c of corpus.placementCases) test(`placement: ${c.id}`, () => {
  const check = () => placement(parseUnique(c.raw));
  if (c.valid) check(); else assert.throws(check);
});
test('finite multi-agent node capacity', () => capacity(corpus.node));
for (const c of corpus.matchingCases) test(`single-node example: ${c.id}`, () => {
  assert.equal(classify({...corpus.node,...c.nodeOverrides},c.placement), c.outcome);
});
for (const [i, e] of corpus.errors.entries()) test(`paired platform error ${i}`, () => unavailable(e));
test('whole-object precedence does not inherit OS into arch-only input', () => {
  const resolve = (...layers) => layers.find(l => l !== undefined);
  assert.deepEqual(resolve({arch:'x86_64'}, {os:'macos'}), {arch:'x86_64'});
  assert.deepEqual(resolve({}, {target:'remote',checkout:'isolated'}), {});
  assert.equal(resolve(undefined, undefined), undefined);
});
test('batch key uses a canonical tuple without ambiguous concatenation', () => {
  const hash = (key, id) => createHash('sha256').update(JSON.stringify([key,id])).digest('hex');
  for (const c of corpus.keys) assert.equal(hash(c.key,c.task), c.sha256);
  assert.notEqual(hash('ab','c'),hash('a','bc'));
});
const badCapacity = (id, mutate) => test(`reject capacity: ${id}`, () => {
  const c=structuredClone(corpus.node);mutate(c);assert.throws(()=>capacity(c));
});
badCapacity('unknown fields',c=>{c.targetId='pool';});
badCapacity('negative slots',c=>{c.reservedAgents=-1;});
badCapacity('overbooked slots',c=>{c.reservedAgents=c.maxAgents+1;});
badCapacity('fractional slots',c=>{c.maxAgents=1.5;});
badCapacity('boolean slots',c=>{c.maxAgents=true;});
badCapacity('1025 slots',c=>{c.maxAgents=1025;});
badCapacity('overbooked memory',c=>{c.usedMemoryBytes=c.memoryBudgetBytes+1;});
badCapacity('missing trusted memory',c=>{delete c.agentMemoryBytes;});
badCapacity('zero trusted memory',c=>{c.agentMemoryBytes=0;});
badCapacity('excess memory',c=>{c.memoryBudgetBytes=2**50+1;});
badCapacity('UTF8 name bound',c=>{c.name='é'.repeat(65);});
badCapacity('control name',c=>{c.name='a\nb';});
test('inclusive bounds and genuine Unicode name accepted',()=>{
  const c={...corpus.node,maxAgents:1024,memoryBudgetBytes:2**50,agentMemoryBytes:2**50,name:'é'.repeat(64)};capacity(c);
});
test('discovery never advertises two nodes',()=>{
  const e=structuredClone(corpus.errors[0]);e.data.supportedPlatforms.push({os:'macos',arch:'aarch64'});assert.throws(()=>unavailable(e));
});
test('correlated alternatives cannot change architecture',()=>{
  const e=structuredClone(corpus.errors[0]);e.data.availablePlatforms=[{os:'linux',arch:'aarch64'}];e.data.availableOs=['linux'];assert.throws(()=>unavailable(e));
});
test('availableOs is an exact projection',()=>{
  const e=structuredClone(corpus.errors[0]);e.data.availableOs=['linux'];assert.throws(()=>unavailable(e));
});
test('capability dependency and exact generation',()=>{
  const ok=c=>c.agentNodes===1&&c.agentPlatformRouting===1;
  assert.equal(ok({agentNodes:1,agentPlatformRouting:1}),true);
  for(const c of [{},{agentNodes:1},{agentPlatformRouting:1},{agentNodes:1,agentPlatformRouting:true},{agentNodes:1,agentPlatformRouting:2}])assert.equal(ok(c),false);
});

// Response-only examples. These assert no runtime persistence or AgentLite hydration.
function launchProjection(l) {
  object(l,['idempotencyKey','state'],['agentId']); str(l.idempotencyKey,128);
  one(l.state,['pending','running','failed','uncertain']);
  if(own(l,'agentId')) assert.match(l.agentId,/^agent-[0-9a-f-]{36}$/);
}
function launchReply(method,r) {
  object(r,['jsonrpc','id'],['error','result']);assert.equal(r.jsonrpc,'2.0');
  assert.notEqual(own(r,'error'),own(r,'result'));
  if(method==='agent.delegate.batch') {
    if(own(r,'error')) {
      object(r.error,['code','message','data']);assert.equal(r.error.code,-32603);
      object(r.error.data,['code','idempotencyKey','retryable']);
      one(r.error.data.code,['batch-launch-pending','batch-launch-outcome-unknown']);
      str(r.error.data.idempotencyKey,128);assert.equal(r.error.data.retryable,true);return;
    }
    object(r.result,['ok','idempotencyKey','tasks','startedTaskIds','summary','unlockPlan','warning']);assert.equal(r.result.ok,true);str(r.result.idempotencyKey,128);
    assert.ok(r.result.tasks.length);assert.deepEqual(r.result.startedTaskIds,[]);
    assert.deepEqual(r.result.summary,{started:0,held:0,skipped:0,errors:r.result.tasks.length});
    for(const row of r.result.tasks) {
      object(row,['taskNoteId','title','disposition','reason','error','launch']);
      assert.equal(row.disposition,'error');assert.deepEqual(row.launch,row.error.data.launch);
      assert.equal(row.launch.idempotencyKey,createHash('sha256').update(JSON.stringify([r.result.idempotencyKey,row.taskNoteId])).digest('hex'));
      launchReply('agent.delegate',{jsonrpc:'2.0',id:r.id,error:row.error});
    }
    return;
  }
  if(own(r,'result')) {
    // The corpus uses the single-delegate success projection; full AgentLite stays unchanged.
    assert.equal(method,'agent.delegate');
    object(r.result,['ok','agentId','name','launch']);assert.equal(r.result.ok,true);
    str(r.result.name,128);launchProjection(r.result.launch);
    assert.equal(r.result.agentId,r.result.launch.agentId);
    assert.ok(r.result.agentId);one(r.result.launch.state,['pending','running']);return;
  }
  object(r.error,['code','message','data']);assert.equal(r.error.code,-32603);str(r.error.message,4096);
  const d=r.error.data;
  if(method==='workspace.create' && ['workspace-create-pending','workspace-create-outcome-unknown'].includes(d.code)) {
    object(d,['code','idempotencyKey','retryable']);str(d.idempotencyKey,128);assert.equal(d.retryable,true);return;
  }
  object(d,['code','idempotencyKey','launch','retryable'],method==='workspace.create'?['workspaceId','cause']:['cause']);
  launchProjection(d.launch);str(d.idempotencyKey,128);
  assert.equal(d.code,({pending:'launch-pending',failed:'launch-failed',uncertain:'launch-outcome-unknown'})[d.launch.state]);
  assert.ok(d.code);assert.equal(d.retryable,d.launch.state!=='failed');
  if(method==='workspace.create') {str(d.workspaceId,128);assert.equal(d.launch.idempotencyKey,createHash('sha256').update(JSON.stringify([d.idempotencyKey,'initialAgent'])).digest('hex'));}
  else assert.equal(d.idempotencyKey,d.launch.idempotencyKey);
  if(d.cause)unavailable(d.cause);
}
for(const c of corpus.responseCases) test(`launch envelope: ${c.id}`,()=>{
  if(c.valid)launchReply(c.method,c.reply);else assert.throws(()=>launchReply(c.method,c.reply));
});
test('canonical response rules preserve required success fields and workspace failure identity',()=>{
  const doc=readFileSync(new URL('../../model-platform-routing.md',import.meta.url),'utf8');
  assert.ok(doc.includes('### Per-method launch responses'));
  for(const token of ['launch-pending','initialAgentLaunch','empty-workspace sentinel','post-creation -32602'])assert.ok(doc.includes(token),token);
});
