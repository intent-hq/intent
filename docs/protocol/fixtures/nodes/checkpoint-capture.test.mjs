// Static prepared-data validation only: no daemon, Git, TLS, filesystem capture,
// authority, task settlement or scheduler acceptance is executed by these tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const hash = s => createHash('sha256').update(s).digest('hex');
const bytes = s => Buffer.byteLength(s, 'utf8');
const U64 = 18446744073709551615n;
const MiB = 1024 * 1024;
function decimal(s, max = U64) {
  assert.equal(typeof s, 'string');
  assert.match(s, /^(0|[1-9][0-9]*)$/);
  assert.ok(BigInt(s) <= BigInt(max));
}
function object(o, required, optional = []) {
  assert.ok(o && typeof o === 'object' && !Array.isArray(o));
  for (const k of required) assert.ok(Object.hasOwn(o, k), `missing ${k}`);
  for (const k of Object.keys(o)) {
    assert.ok(required.includes(k) || optional.includes(k), `unknown ${k}`);
    assert.notEqual(o[k], null, `null ${k}`);
  }
}
function text(s, max = 4096) { assert.equal(typeof s, 'string'); assert.ok(bytes(s) > 0 && bytes(s) <= max); }
function sha(s) { assert.equal(typeof s, 'string'); assert.match(s, /^[0-9a-f]{64}$/); }
function oid(s) { assert.equal(typeof s, 'string'); assert.match(s, /^[0-9a-f]{40}$/); }
function uuid(s) { assert.equal(typeof s, 'string'); assert.match(s, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); assert.notEqual(s, '00000000-0000-0000-0000-000000000000'); }
// Preserve duplicate-key detection before JSON.parse can discard a member.
function strict(raw) {
  let i = 0;
  const ws = () => { while (/\s/.test(raw[i] ?? '') && i < raw.length) i++; };
  function string() {
    assert.equal(raw[i++], '"'); const start = i - 1;
    while (i < raw.length) {
      if (raw[i] === '\\') { i += 2; continue; }
      if (raw[i++] === '"') return JSON.parse(raw.slice(start, i));
    }
    assert.fail('unterminated string');
  }
  function value() {
    ws();
    if (raw[i] === '{') {
      i++; ws(); const keys = new Set();
      if (raw[i] === '}') { i++; return; }
      while (true) {
        ws(); const key = string(); assert.ok(!keys.has(key), `duplicate ${key}`); keys.add(key);
        ws(); assert.equal(raw[i++], ':'); value(); ws();
        const end = raw[i++]; if (end === '}') return; assert.equal(end, ',');
      }
    }
    if (raw[i] === '[') {
      i++; ws(); if (raw[i] === ']') { i++; return; }
      while (true) { value(); ws(); const end = raw[i++]; if (end === ']') return; assert.equal(end, ','); }
    }
    if (raw[i] === '"') { string(); return; }
    const start = i; while (i < raw.length && !/[\s,}\]]/.test(raw[i])) i++;
    assert.ok(i > start); JSON.parse(raw.slice(start, i));
  }
  value(); ws(); assert.equal(i, raw.length); return JSON.parse(raw);
}
function manifest(raw) {
  assert.ok(bytes(raw) <= MiB);
  const m = strict(raw);
  const keys = ['formatVersion','checkpointId','workspaceId','agentId','leaseId','incarnation','runId','assignmentEpoch','captureRevision','capturedAt','journalSeq','repos','session','attachments'];
  object(m, keys); assert.equal(m.formatVersion, 1);
  for (const k of ['checkpointId','incarnation','runId']) uuid(m[k]);
  for (const k of ['workspaceId','agentId','leaseId']) text(m[k]);
  for (const k of ['assignmentEpoch','captureRevision','journalSeq']) decimal(m[k]);
  assert.ok(BigInt(m.assignmentEpoch) > 0n && BigInt(m.captureRevision) > 0n);
  assert.equal(typeof m.capturedAt, 'string'); assert.match(m.capturedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/); assert.ok(Number.isFinite(Date.parse(m.capturedAt)));
  assert.ok(Array.isArray(m.repos) && m.repos.length > 0 && m.repos.length <= 64);
  const repoKeys = new Set(); const paths = new Set();
  for (const [n, r] of m.repos.entries()) {
    object(r, ['repoKey','path','forkBase','objectFormat','head','index','submodules'], ['wip','branch','inherited']);
    text(r.repoKey, 128); text(r.path); assert.ok(!repoKeys.has(r.repoKey) && !paths.has(r.path)); repoKeys.add(r.repoKey); paths.add(r.path);
    if (n === 0) assert.equal(r.path, '.'); else assert.ok(!r.path.startsWith('/') && !r.path.split('/').some(p => !p || p === '..' || p === '.' || p.toLowerCase() === '.git'));
    assert.equal(r.objectFormat, 'sha1'); for (const k of ['forkBase','head','index']) oid(r[k]);
    if (Object.hasOwn(r,'wip')) oid(r.wip); if (Object.hasOwn(r,'branch')) text(r.branch);
    assert.ok(Array.isArray(r.submodules)); for (const sub of r.submodules) { object(sub,['path','repoKey']); text(sub.path); text(sub.repoKey,128); }
    if (r.inherited) { object(r.inherited,['sourceAgentId','checkpointId','executionBase']); text(r.inherited.sourceAgentId); uuid(r.inherited.checkpointId); oid(r.inherited.executionBase); }
  }
  for (const [n,r] of m.repos.entries()) for (const sub of r.submodules) {
    const at=m.repos.findIndex(x => x.repoKey===sub.repoKey); assert.ok(at>n);
    assert.equal(m.repos[at].path, r.path==='.' ? sub.path : `${r.path}/${sub.path}`);
  }
  object(m.session,['provider','mode','throughSeq','files']); text(m.session.provider,128); assert.equal(m.session.mode,'history'); assert.equal(m.session.throughSeq,m.journalSeq); assert.deepEqual(m.session.files,[]);
  assert.ok(Array.isArray(m.attachments) && m.attachments.length<=128);
  const attachments=new Set(); for (const a of m.attachments) { object(a,['attachmentId','sha256']); text(a.attachmentId,128); sha(a.sha256); assert.ok(!attachments.has(a.attachmentId)); attachments.add(a.attachmentId); }
  // Reconstruct the declared typed field order rather than accepting arbitrary
  // JSON object ordering as evidence of the pinned serde byte representation.
  const typed=Object.fromEntries(keys.map(k=>[k,m[k]]));
  typed.repos=m.repos.map(r=>Object.fromEntries(['repoKey','path','forkBase','objectFormat','head','index','wip','branch','submodules','inherited'].filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])));
  assert.equal(JSON.stringify(typed),raw);
  return m;
}
function prepare(raw) {
  assert.ok(bytes(raw)<=8*MiB); const p=strict(raw);
  object(p,['manifestSha256','manifestJson','repositories','attachments']); sha(p.manifestSha256); text(p.manifestJson,MiB);
  assert.equal(hash(p.manifestJson),p.manifestSha256); const m=manifest(p.manifestJson);
  assert.ok(Array.isArray(p.repositories)); assert.deepEqual(p.repositories.map(r=>r.repoKey),m.repos.map(r=>r.repoKey));
  let charge=BigInt(bytes(p.manifestJson));
  for(const r of p.repositories) { object(r,['repoKey','objectBytes']); text(r.repoKey,128); decimal(r.objectBytes,256*MiB); charge+=BigInt(r.objectBytes); }
  assert.ok(Array.isArray(p.attachments)); assert.deepEqual(p.attachments.map(a=>a.id),m.attachments.map(a=>a.attachmentId).sort());
  for(const a of p.attachments) { object(a,['id','sha256','bytes']); text(a.id,128); sha(a.sha256); decimal(a.bytes,256*MiB); assert.equal(a.sha256,m.attachments.find(x=>x.attachmentId===a.id).sha256); charge+=BigInt(a.bytes); }
  assert.ok(charge<=BigInt(1024*MiB)); return m;
}
const data=strict(readFileSync(new URL('./checkpoint-capture.json',import.meta.url),'utf8'));
test('prepared corpus identifies its limits and unique scenario identities',()=>{
  assert.equal(data.nodeProtocol,3); assert.equal(data.checkpointFormat,1); assert.equal(data.qualification,'prepared-data-and-static-integrity-only');
  for(const group of [data.examples,data.invalidRequests,data.runtimeScenarios]) assert.equal(new Set(group.map(x=>x.id)).size,group.length);
  assert.ok(data.runtimeScenarios.length>=42); for(const s of data.runtimeScenarios) { assert.equal(s.executed,false); text(s.when); text(s.required); }
});
for(const e of data.examples) test(`prepared example: ${e.id}`,()=>{
  const m=prepare(JSON.stringify(e.prepare.params)); const p=e.prepare;
  assert.equal(p.scope.method,'checkpoint.prepare'); assert.equal(p.scope.idempotencyKey,m.checkpointId); assert.equal(p.scope.agentId,m.agentId); assert.equal(p.scope.workspaceId,m.workspaceId);
  object(p.result,['checkpointId','manifestSha256','expiresAtMs']); assert.equal(p.result.checkpointId,m.checkpointId); assert.equal(p.result.manifestSha256,p.params.manifestSha256); decimal(p.result.expiresAtMs);
  object(e.commit.params,['checkpointId','manifestSha256','runId','assignmentEpoch','captureRevision']); for(const k of ['checkpointId','runId','assignmentEpoch','captureRevision']) assert.equal(e.commit.params[k],m[k]); assert.equal(e.commit.params.manifestSha256,p.params.manifestSha256);
  assert.equal(e.commit.scope.method,'checkpoint.commit'); assert.equal(e.commit.scope.idempotencyKey,m.checkpointId); assert.notEqual(e.commit.scope.requestId,p.scope.requestId);
  object(e.commit.result,['checkpointId','outcome','currentCheckpointId']); assert.equal(e.commit.result.checkpointId,m.checkpointId); assert.ok(['advanced','historical'].includes(e.commit.result.outcome)); uuid(e.commit.result.currentCheckpointId);
  assert.equal(e.stageBindings.length,m.repos.length); for(const [i,s] of e.stageBindings.entries()) { assert.equal(s.service,'checkpoint-stage'); assert.equal(s.method,'git.receivePack'); assert.equal(s.repoKey,m.repos[i].repoKey); assert.equal(s.checkpoint.manifestSha256,p.params.manifestSha256); for(const k of ['checkpointId','runId','assignmentEpoch','captureRevision']) assert.equal(s.checkpoint[k],m[k]); for(const [k,v] of Object.entries(s.checkpoint.snapshot)) assert.equal(v,m.repos[i][k]); }
  for(const a of e.artifacts) { assert.equal(hash(a.utf8),a.sha256); assert.equal(String(bytes(a.utf8)),a.bytes); assert.deepEqual(p.params.attachments.find(x=>x.id===a.id),{id:a.id,sha256:a.sha256,bytes:a.bytes}); }
});
for(const e of data.invalidRequests) test(`prepared rejection: ${e.id}`,()=>{assert.equal(e.executedRuntime,false); assert.equal(e.expectedStaticResult,'reject'); assert.throws(()=>prepare(e.prepareJson));});
test('schema limits reject exact overflow without allocating native resources',()=>{
  for(const n of ['0','18446744073709551615']) decimal(n);
  for(const n of ['00','-1','+1','18446744073709551616']) assert.throws(()=>decimal(n));
  assert.throws(()=>manifest(' '.repeat(MiB+1)));
  assert.throws(()=>strict('{"a":1,"\\u0061":2}'));
});

test('prepared errors use the existing JSON-RPC data.code envelope',()=>{
  const mapping={'invalid-params':-32602,'stale-checkpoint-owner':-32003,'checkpoint-busy':-32005,'rpc-outcome-unknown':-32603};
  for(const envelope of data.errorExamples) { object(envelope,['error']); object(envelope.error,['code','message','data']); object(envelope.error.data,['code']); assert.equal(envelope.error.code,mapping[envelope.error.data.code]); text(envelope.error.message); }
});
