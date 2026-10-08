// Controlled wire and lifecycle specification oracle. No database, auth provider,
// scheduler, timer, transport or component implementation is exercised here.
import assert from 'node:assert/strict';
export const LIMITS = Object.freeze({defaultDelayMs:15000,maxDelayMs:60000,admissionAgeMs:60000,
  retentionMs:300000,workspaceEntries:256,globalEntries:1024,workers:4,directChildren:256,
  resultBytes:524288,idBytes:128,wallBytes:30});
const states = ['PENDING','COMMITTING','CANCELLED','DELETED','CONFLICT','FAILED','OUTCOME_UNKNOWN'];
const active = ['PENDING','COMMITTING'];
const visible = [...active,'OUTCOME_UNKNOWN'];
const reasons = [null,'cancelled','noteChanged','childChanged','noteMissing','workspaceMissing',
  'authorityLost','deadlineBudget','storageFailure','shutdown','commitOutcomeUnknown'];
const bytes = s => Buffer.byteLength(s,'utf8');
const tick = n => assert.ok(Number.isSafeInteger(n) && n >= 0);
const id = s => assert.ok(typeof s === 'string' && bytes(s)>0 && bytes(s)<=LIMITS.idBytes);
const uuid = s => assert.match(s,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const keys = (x, required, optional=[]) => {
  assert.ok(x && typeof x==='object' && !Array.isArray(x));
  for (const k of required) assert.ok(Object.hasOwn(x,k),k);
  for (const k of Object.keys(x)) assert.ok([...required,...optional].includes(k),k);
};
const wall = s => { assert.ok(typeof s==='string' && bytes(s)<=LIMITS.wallBytes);
  assert.match(s,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/); assert.ok(Number.isFinite(Date.parse(s))); };
export const graceSupported = hello => hello?.result?.server?.capabilities?.noteDeleteGrace === 1;
export function assertKey(k) { keys(k,['epoch','issuedTickMs','nonce']);uuid(k.epoch);tick(k.issuedTickMs);uuid(k.nonce); }
export function assertIdentity(x) { keys(x,['noteInstanceId','revision','sourceRevision']);id(x.noteInstanceId);tick(x.revision);id(x.sourceRevision); }
export function assertRequest(method, x) {
  const required=['workspaceId'], optional=[];
  if (method==='note.deleteSchedule') {
    required.push('noteId','noteInstanceId','expectedVersion','sourceRevision','operationKey');optional.push('undoDelayMs');
  } else if (method==='note.deleteCancel') required.push('noteId','operationKey');
  else { assert.equal(method,'note.deleteStatus');optional.push('noteId','operationKey'); }
  keys(x,required,optional);id(x.workspaceId);
  if (Object.hasOwn(x,'noteId')) id(x.noteId);
  if (Object.hasOwn(x,'operationKey')) { assert.ok(Object.hasOwn(x,'noteId')); assertKey(x.operationKey); }
  if (method==='note.deleteSchedule') {
    id(x.noteInstanceId);id(x.sourceRevision);tick(x.expectedVersion);
    if (Object.hasOwn(x,'undoDelayMs')) { tick(x.undoDelayMs);assert.ok(x.undoDelayMs>=1 && x.undoDelayMs<=60000); }
  }
}
export function assertReceipt(r) {
  if (r.state==='UNKNOWN') {
    keys(r,['operationKey','state','reason']);assertKey(r.operationKey);
    assert.ok(['previousEpoch','unavailable'].includes(r.reason));return;
  }
  keys(r,['operationKey','workspaceId','noteId','noteInstanceId','state','sequence','deadlineTickMs','deleteAt','expiresTickMs','reason']);
  assertKey(r.operationKey);for (const k of ['workspaceId','noteId','noteInstanceId']) id(r[k]);
  assert.ok(states.includes(r.state));tick(r.sequence);tick(r.deadlineTickMs);wall(r.deleteAt);
  assert.ok(reasons.includes(r.reason));
  if (active.includes(r.state)) assert.equal(r.expiresTickMs,null);
  else if (r.expiresTickMs!==null) tick(r.expiresTickMs);
  if (r.state==='OUTCOME_UNKNOWN') {assert.equal(r.reason,'commitOutcomeUnknown');tick(r.expiresTickMs);}
}
export function assertMarker(m) {
  keys(m,['operationKey','noteId','noteInstanceId','state','sequence','deadlineTickMs','deleteAt','canCancel']);
  assertKey(m.operationKey);id(m.noteId);id(m.noteInstanceId);assert.ok(visible.includes(m.state));
  tick(m.sequence);tick(m.deadlineTickMs);wall(m.deleteAt);assert.equal(typeof m.canCancel,'boolean');
  if (m.state!=='PENDING') assert.equal(m.canCancel,false);
}
export function assertResult(method, request, r) {
  assertRequest(method,request);assert.ok(bytes(JSON.stringify(r))<=LIMITS.resultBytes);
  const status=method==='note.deleteStatus';
  keys(r,['epoch','serverTickMs','sequence','operation',...(status?['current','pending']:[])]);
  uuid(r.epoch);tick(r.serverTickMs);tick(r.sequence);
  if (r.operation!==null) {
    assertReceipt(r.operation);
    assert.deepEqual(r.operation.operationKey,request.operationKey);
    if (r.operation.state!=='UNKNOWN') {
      assert.equal(r.operation.workspaceId,request.workspaceId);assert.equal(r.operation.noteId,request.noteId);
      assert.equal(r.operation.operationKey.epoch,r.epoch);assert.ok(r.operation.sequence<=r.sequence);
      if (method==='note.deleteSchedule') assert.equal(r.operation.noteInstanceId,request.noteInstanceId);
    } else if (r.operation.reason==='previousEpoch') assert.notEqual(r.operation.operationKey.epoch,r.epoch);
    else assert.equal(r.operation.operationKey.epoch,r.epoch);
  }
  if (!status) {assert.notEqual(r.operation,null);if(method==='note.deleteSchedule')assert.notEqual(r.operation.state,'UNKNOWN');return;}
  if (request.operationKey) assert.notEqual(r.operation,null);else assert.equal(r.operation,null);
  assert.ok(Array.isArray(r.pending));assert.ok(r.pending.length<=(request.noteId?1:256));
  if (r.current!==null) assertIdentity(r.current);
  if (!request.noteId) assert.equal(r.current,null);
  if (request.noteId && r.current===null) assert.deepEqual(r.pending,[]);
  const seen=new Set();
  for (const m of r.pending) {
    assertMarker(m);assert.equal(m.operationKey.epoch,r.epoch);assert.ok(m.sequence<=r.sequence);
    const address=JSON.stringify([m.noteId,m.noteInstanceId]);assert.ok(!seen.has(address));seen.add(address);
    if (request.noteId) {assert.equal(m.noteId,request.noteId);assert.equal(m.noteInstanceId,r.current.noteInstanceId);}
  }
}
export function assertEvent(e) {
  keys(e,['workspaceId','noteId','noteInstanceId','epoch','sequence','operationKey','state','deadlineTickMs']);
  for(const k of ['workspaceId','noteId','noteInstanceId'])id(e[k]);uuid(e.epoch);assertKey(e.operationKey);
  assert.equal(e.epoch,e.operationKey.epoch);assert.ok(states.includes(e.state));tick(e.sequence);tick(e.deadlineTickMs);
}
export function remaining(receipt,responseTick,roundTripMs) {
  tick(responseTick);assert.ok(Number.isFinite(roundTripMs)&&roundTripMs>=0);
  return Math.max(0,receipt.deadlineTickMs-responseTick-roundTripMs);
}

// One-operation state oracle for deterministic traces. Scope/auth/current guards
// are explicit fixture inputs, not claims that real credentials or DB CAS ran.
export class GraceTrace {
  constructor(request, epoch, now) {
    assertRequest('note.deleteSchedule',request);assert.equal(request.operationKey.epoch,epoch);
    tick(now);assert.ok(request.operationKey.issuedTickMs<=now && now-request.operationKey.issuedTickMs<=60000);
    this.request=structuredClone(request);this.delay=request.undoDelayMs??15000;
    this.deadline=now+this.delay;this.state='PENDING';this.settled=false;this.expiry=null;
    this.deletions=0;this.epoch=epoch;
  }
  replay(request,now,authorized=true) {
    assert.ok(authorized);assertRequest('note.deleteSchedule',request);
    if(this.expiry!==null && now>=this.expiry) {assert.ok(now-request.operationKey.issuedTickMs>60000);throw new Error('NOTE_DELETE_KEY_EXPIRED');}
    const normalized=x=>({...x,undoDelayMs:x.undoDelayMs??15000});
    assert.deepEqual(normalized(request),normalized(this.request));return this.state;
  }
  cancel(authorized=true) {assert.ok(authorized);if(this.state==='PENDING'){this.state='CANCELLED';}return this.state;}
  claim(now) {assert.ok(now>=this.deadline);if(this.state==='PENDING')this.state='COMMITTING';return this.state;}
  outcome(state,{guards=true,authorized=true}={}) {
    assert.equal(this.state,'COMMITTING');
    assert.ok(['DELETED','CONFLICT','FAILED','OUTCOME_UNKNOWN'].includes(state));
    if(state==='DELETED'){assert.ok(guards&&authorized);this.deletions++;}
    // Ambiguous acknowledgement cannot become a public settled receipt while
    // physical work remains. Keep COMMITTING until settle supplies the boundary.
    if(state==='OUTCOME_UNKNOWN')this.settledOutcome=state;else this.state=state;
  }
  settle(now) {tick(now);assert.ok(!this.settled);
    if(this.settledOutcome)this.state=this.settledOutcome;
    assert.ok(!active.includes(this.state));this.settled=true;this.expiry=now+300000;}
  expired(now) {return this.settled && now>=this.expiry;}
  markerVisible() {return visible.includes(this.state);}
}
