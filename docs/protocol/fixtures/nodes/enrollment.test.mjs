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

// RFC 8785 subset used by these fixtures: finite I-JSON values, ECMAScript
// number encoding, UTF-16 key ordering; never normalize the manifest string.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  if (typeof value === 'number') assert.ok(Number.isFinite(value));
  if (typeof value === 'string') assert.ok(value.isWellFormed());
  return JSON.stringify(value);
}
function positive(s) { decimal(s); assert.ok(BigInt(s)>0n); }
function configuration(c) {
  object(c,['configId','sha256','snapshot']); uuid(c.configId); sha(c.sha256);
  const s=c.snapshot; object(s,['schemaVersion','providerId','permissionPolicy','toolProfile','terminal','externalAcpMcp'],['model','reasoningEffort']);
  assert.equal(s.schemaVersion,1); text(s.providerId,128); assert.match(s.providerId,/^[A-Za-z0-9_-]+$/);
  assert.ok(['interactive','autoByRisk','allowAll','denyAll'].includes(s.permissionPolicy));
  assert.equal(s.toolProfile,'contained-v1'); assert.equal(s.terminal,false); assert.deepEqual(s.externalAcpMcp,[]);
  for(const k of ['model','reasoningEffort']) if(Object.hasOwn(s,k)) text(s[k],256);
  assert.ok(bytes(canonical(s))<=32768); assert.equal(hash(canonical(s)),c.sha256);
}
function preparation(p) {
  object(p,['preparationId','runId','assignmentEpoch','checkpoint','configuration','sourceMetadata'],['resume']);
  uuid(p.preparationId);uuid(p.runId);positive(p.assignmentEpoch);
  // This initial real receiver has no qualified resume/import adapter.
  assert.ok(!Object.hasOwn(p,'resume'),'unsupported resume in initial profile');
  configuration(p.configuration);object(p.checkpoint,['checkpointId','manifestSha256']);uuid(p.checkpoint.checkpointId);sha(p.checkpoint.manifestSha256);
  object(p.sourceMetadata,['manifestJson','attachments']);
  const m=manifest(p.sourceMetadata.manifestJson);assert.equal(hash(p.sourceMetadata.manifestJson),p.checkpoint.manifestSha256);assert.equal(m.checkpointId,p.checkpoint.checkpointId);
  const a=p.sourceMetadata.attachments;assert.ok(Array.isArray(a)&&a.length<=128);
  assert.deepEqual(a.map(x=>x.id),m.attachments.map(x=>x.attachmentId).sort());let total=0;
  for(const x of a){object(x,['id','sha256','bytes']);text(x.id,128);sha(x.sha256);assert.ok(Number.isSafeInteger(x.bytes)&&x.bytes>=0&&x.bytes<=256*MiB);total+=x.bytes;assert.equal(x.sha256,m.attachments.find(y=>y.attachmentId===x.id).sha256);}
  assert.ok(total<=1024*MiB);return m;
}
function installHash(owner,h,p) {
  const install={...p};delete install.intentSha256;
  return hash(canonical({bindingOwner:owner,agentId:h.agentId,workspaceId:h.workspaceId,install}));
}
function envelope(e) {
  assert.equal(e.nodeProtocol,4);assert.equal(e.direction,'head-to-node');
  const o=e.bindingOwner;object(o,['headId','nodeId','nodeIdentity','leaseId','incarnation']);for(const k of ['headId','nodeId','nodeIdentity','leaseId'])text(o[k]);uuid(o.incarnation);
  const h=e.request.header;object(h,['channel','streamId','kind','leaseId','incarnation','linkGeneration','requestId','agentId','workspaceId','method','timeoutMs','offset','more','idempotencyKey']);
  assert.equal(h.channel,'rpc');assert.equal(h.kind,'request');assert.equal(h.method,'node.assignment.enroll');uuid(h.requestId);assert.equal(h.streamId,h.requestId);assert.equal(h.leaseId,o.leaseId);assert.equal(h.incarnation,o.incarnation);positive(h.linkGeneration);text(h.agentId);text(h.workspaceId);
  assert.ok(Number.isInteger(h.timeoutMs)&&h.timeoutMs>=1&&h.timeoutMs<=120000);assert.equal(h.offset,0);assert.equal(h.more,false);assert.ok(bytes(JSON.stringify(h))<=16384);
  const p=e.request.payload;assert.ok(bytes(JSON.stringify(p))<=8*MiB);
  let id,run,epoch;
  if(p.action==='install'){
    object(p,['action','intentSha256','originGeneration','expiresAt','assignment','memoryBytes','prepare']);
    positive(p.originGeneration);assert.equal(p.originGeneration,h.linkGeneration);
    assert.match(p.expiresAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);assert.ok(Number.isFinite(Date.parse(p.expiresAt)));
    assert.ok(Number.isSafeInteger(p.memoryBytes)&&p.memoryBytes>=1&&p.memoryBytes<=2**50);
    object(p.assignment,['repoKeys'],['inheritedCheckpointId','mergeTargetAgentId']);
    const keys=p.assignment.repoKeys;assert.ok(Array.isArray(keys)&&keys.length>=1&&keys.length<=64);assert.equal(new Set(keys).size,keys.length);
    for(const k of keys){text(k,128);assert.ok(!/[\u0000-\u001f\u007f-\u009f]/u.test(k));}
    assert.deepEqual(keys,[...keys].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
    const m=preparation(p.prepare);assert.equal(m.workspaceId,h.workspaceId);assert.deepEqual(keys,m.repos.map(r=>r.repoKey).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
    if(p.assignment.inheritedCheckpointId){uuid(p.assignment.inheritedCheckpointId);assert.equal(p.assignment.inheritedCheckpointId,m.checkpointId);assert.equal(p.assignment.mergeTargetAgentId,m.agentId);}else assert.equal(m.agentId,h.agentId);
    if(p.assignment.mergeTargetAgentId)text(p.assignment.mergeTargetAgentId);
    sha(p.intentSha256);assert.equal(p.intentSha256,installHash(o,h,p));
    ({preparationId:id,runId:run,assignmentEpoch:epoch}=p.prepare);
  } else {
    object(p,['action','preparationId','runId','assignmentEpoch','originGeneration','intentSha256']);assert.equal(p.action,'close');
    uuid(p.preparationId);uuid(p.runId);positive(p.assignmentEpoch);positive(p.originGeneration);sha(p.intentSha256);
    assert.ok(BigInt(p.originGeneration)<=BigInt(h.linkGeneration));
    if(p.originGeneration!==h.linkGeneration)assert.equal(e.requiresRetainedCorrelation,true);
    ({preparationId:id,runId:run,assignmentEpoch:epoch}=p);
  }
  assert.equal(h.idempotencyKey,id);
  object(e.response,['result']);const r=e.response.result;object(r,['preparationId','runId','assignmentEpoch','originGeneration','intentSha256','revision','state','ownership']);
  assert.equal(r.preparationId,id);assert.equal(r.runId,run);assert.equal(r.assignmentEpoch,epoch);assert.equal(r.originGeneration,p.originGeneration);assert.equal(r.intentSha256,p.intentSha256);decimal(r.revision);
  assert.ok(['pending','installed','closing','closed','failed_retained'].includes(r.state));assert.ok(['held','released'].includes(r.ownership));if(r.ownership==='released')assert.equal(r.state,'closed');if(r.state!=='closed')assert.equal(r.ownership,'held');assert.ok(bytes(JSON.stringify(r))<=4096);
}
const data=strict(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(new URL('./enrollment.json',import.meta.url))));
test('prepared corpus and explicit supported version sets',()=>{
  assert.equal(data.qualification,'prepared-data-and-static-integrity-only');assert.deepEqual(data.versions,{lifecycle:[2,3,4],capture:[3,4],enrollment:[4],checkpointFormat:1,journalFormat:1});
  for(const v of [0,1,5,255])for(const family of ['lifecycle','capture','enrollment'])assert.ok(!data.versions[family].includes(v));
  for(const list of [data.examples,data.invalidExamples,data.invalidRawJson,data.runtimeScenarios])assert.equal(new Set(list.map(x=>x.id)).size,list.length);
  for(const x of data.runtimeScenarios){assert.equal(x.executed,false);text(x.required);}
});
for(const e of data.examples)test(`prepared envelope: ${e.id}`,()=>envelope(e));
for(const e of data.invalidExamples)test(`static rejection: ${e.id}`,()=>{assert.equal(e.executedRuntime,false);assert.equal(e.expected,'reject-static');assert.throws(()=>envelope(e.example));});
for(const e of data.invalidRawJson)test(`raw rejection: ${e.id}`,()=>assert.throws(()=>strict(e.raw)));
test('raw nested Prepare duplicates cannot disappear before intent validation',()=>{
  const e=data.examples[0],p=JSON.stringify(e.request.payload);
  assert.throws(()=>strict(p.replace('"memoryBytes":268435456','"memoryBytes":268435456,"memoryBytes":1')));
  const inner=e.request.payload.prepare.sourceMetadata.manifestJson;assert.throws(()=>manifest(inner.replace('"formatVersion":1','"formatVersion":1,"formatVersion":1')));
});
test('intent binds target, owner, configuration, source bytes, descriptors and expiry',()=>{
  const e=data.examples[0],p=e.request.payload;
  for(const key of Object.keys(e.bindingOwner)){const owner={...e.bindingOwner,[key]:`${e.bindingOwner[key]}changed`};assert.notEqual(installHash(owner,e.request.header,p),p.intentSha256);}
  for(const key of ['agentId','workspaceId'])assert.notEqual(installHash(e.bindingOwner,{...e.request.header,[key]:'changed'},p),p.intentSha256);
  for(const mutate of [x=>x.memoryBytes++,x=>x.expiresAt='2026-10-01T15:02:01Z',x=>x.prepare.sourceMetadata.attachments[0].bytes++,x=>x.prepare.sourceMetadata.manifestJson+=' ',x=>x.prepare.configuration.snapshot.permissionPolicy='allowAll']){const x=structuredClone(p);mutate(x);assert.notEqual(installHash(e.bindingOwner,e.request.header,x),p.intentSha256);}
});
test('bounds exercise accepted edge and rejected overflow without native allocation',()=>{
  for(const value of ['1','18446744073709551615'])positive(value);for(const value of ['0','01','18446744073709551616'])assert.throws(()=>positive(value));
  for(const memory of [1,2**50]){const e=structuredClone(data.examples[0]);e.request.payload.memoryBytes=memory;e.request.payload.intentSha256=installHash(e.bindingOwner,e.request.header,e.request.payload);e.response.result.intentSha256=e.request.payload.intentSha256;envelope(e);}
  assert.throws(()=>text('é'.repeat(65),128));assert.throws(()=>manifest(' '.repeat(MiB+1)));
});
test('retained identity and numerically ordered observations are distinct from authority',()=>{
  const replies=data.examples.filter(e=>e.id!=='install-inherited').map(e=>e.response.result);for(const r of replies)assert.equal(r.intentSha256,replies[0].intentSha256);
  const current={...replies[0],revision:'10',state:'closed',ownership:'released'},late={...replies[0],revision:'9'};
  const choose=(a,b)=>BigInt(b.revision)>BigInt(a.revision)?b:a;assert.equal(choose(current,late),current);assert.equal(choose(late,current),current);
  // This is only a numeric observation rule; no installation/permission is made.
});
test('earliest ORIGINAL deadline, including source300s, defeats outer600s',()=>{
  const earliest=x=>Math.min(...Object.values(x));
  const original={enrollment:600,source:300,target:500,lease:450,firstReceiptPlus120:320};assert.equal(earliest(original),300);
  const first={...original,firstReceiptPlus120:120};assert.equal(earliest(first),120);
  const persisted=earliest(first);assert.equal(Math.min(persisted,earliest({...first,firstReceiptPlus120:1000})),120);
});
test('canonical documentation preserves enrollment bounds and non-public routing',()=>{
  const docs=readFileSync(new URL('../../node-link.md',import.meta.url),'utf8');
  for(const literal of ['node.assignment.enroll','1,232,896','36,864','4096','300 seconds','600-second','SAME retained HeadWorkspaceAuthority','pre-grant','StartedWrite','quarantine'])assert.ok(docs.includes(literal),literal);
  for(const p of ['../../05-method-catalog.md','../../workspace-routing.md'])assert.ok(!readFileSync(new URL(p,import.meta.url),'utf8').split('\n').some(l=>l.startsWith('|')&&l.includes('node.assignment.enroll')));
});
test('prepared enrollment errors have exact sanitized JSON-RPC mappings',()=>{
  const codes={'invalid-params':-32602,forbidden:-32003,'stale-assignment':-32003,'enrollment-conflict':-32005,'enrollment-unavailable':-32603,'unsupported-configuration':-32602,'enrollment-outcome-unknown':-32603};
  assert.equal(data.errorExamples.length,Object.keys(codes).length);
  for(const e of data.errorExamples){object(e,['error']);object(e.error,['code','message','data']);object(e.error.data,['code']);assert.equal(e.error.code,codes[e.error.data.code]);assert.equal(e.error.message,e.error.data.code);}
});
