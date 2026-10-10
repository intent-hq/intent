import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
test('grace deletion reserves distinct guarded methods without changing immediate deletion', async () => {
  const notes = await read('../../methods/notes-tasks.md');
  for (const method of ['deleteSchedule', 'deleteCancel', 'deleteStatus'])
    assert.ok(notes.includes(`| note.${method} `));
  assert.ok(notes.includes('| note.delete | noteId (req), expectedVersion?: int |'));
  const docs = await read('../../note-delete-grace.md');
  for (const word of ['noteDeleteGrace: 1', 'OUTCOME_UNKNOWN', 'WireCredential',
    'CURRENT incarnation', 'no NEW operation', '524288', '300000', '60000']) assert.ok(docs.includes(word), word);
  const versioning = await read('../../versioning.md');
  assert.match(versioning, /\*\*Documented version:\*\* `13\.10`/);
  assert.ok(versioning.includes('**Version 13.9 —'));
  const catalog = await read('../../05-method-catalog.md');
  assert.ok(catalog.includes('**447 dispatchable method names**'));
  const events = JSON.parse(await read('../../event-types.json'));
  assert.ok(events.types.includes('note:delete-operation'));
});

import { LIMITS, graceSupported, assertRequest, assertReceipt, assertResult, assertEvent,
  GraceTrace, remaining } from './delete-grace.mjs';
const fixture = JSON.parse(await read('./delete-grace.json'));
const copy = value => structuredClone(value);
const schedule = fixture.schedule;
const pending = fixture.pending;
const response = operation => ({epoch:fixture.epoch,serverTickMs:1000,sequence:1,operation});
const marker = (receipt=pending) => ({operationKey:receipt.operationKey,noteId:receipt.noteId,
  noteInstanceId:receipt.noteInstanceId,state:receipt.state,sequence:receipt.sequence,
  deadlineTickMs:receipt.deadlineTickMs,deleteAt:receipt.deleteAt,canCancel:receipt.state==='PENDING'});
const status = (current=null, list=[]) => ({...response(null),current,pending:list});
const identity = {noteInstanceId:pending.noteInstanceId,revision:7,sourceRevision:'r:7:9'};
const keyed = {workspaceId:schedule.workspaceId,noteId:schedule.noteId,operationKey:fixture.key};
const noteRequest = {workspaceId:schedule.workspaceId,noteId:schedule.noteId};

test('only the exact separate integer capability enables grace deletion', () => {
  for(const value of [undefined,null,false,true,0,'1',2])
    assert.equal(graceSupported({result:{server:{capabilities:{noteDeleteGrace:value,notePagingRead:1}}}}),false);
  assert.equal(graceSupported({result:{server:{capabilities:fixture.capability}}}),true);
  assert.equal(graceSupported({}),false);
  assert.deepEqual(fixture.limits,LIMITS);
});

test('schedule guards are mandatory and delay never degenerates into immediate deletion', () => {
  assertRequest('note.deleteSchedule',schedule);
  for(const delay of [1,15000,60000]) assertRequest('note.deleteSchedule',{...schedule,undoDelayMs:delay});
  for(const delay of [null,0,-1,60001,1.5,'15000',Infinity])
    assert.throws(()=>assertRequest('note.deleteSchedule',{...schedule,undoDelayMs:delay}));
  for(const key of Object.keys(schedule)) {
    const request=copy(schedule);delete request[key];assert.throws(()=>assertRequest('note.deleteSchedule',request));
  }
  assert.throws(()=>assertRequest('note.deleteSchedule',{...schedule,content:'a complete body'}));
  assert.throws(()=>assertRequest('note.delete',{noteId:schedule.noteId,undoDelayMs:15000}));
});

test('UTF8 byte bounds and safe integers apply before admission', () => {
  assertRequest('note.deleteSchedule',{...schedule,noteId:'🙂'.repeat(32)});
  for(const noteId of ['', '🙂'.repeat(33)]) assert.throws(()=>assertRequest('note.deleteSchedule',{...schedule,noteId}));
  for(const expectedVersion of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'7'])
    assert.throws(()=>assertRequest('note.deleteSchedule',{...schedule,expectedVersion}));
  for(const issuedTickMs of [-1,1.5,Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>assertRequest('note.deleteSchedule',{...schedule,operationKey:{...fixture.key,issuedTickMs}}));
  assert.throws(()=>assertRequest('note.deleteSchedule',{...schedule,operationKey:{...fixture.key,nonce:'not-a-uuid'}}));
});

test('workspace discovery is one request; historical keys require a note target', () => {
  assertRequest('note.deleteStatus',{workspaceId:schedule.workspaceId});
  assertRequest('note.deleteStatus',noteRequest);assertRequest('note.deleteStatus',keyed);
  assertRequest('note.deleteCancel',keyed);
  assert.throws(()=>assertRequest('note.deleteStatus',{workspaceId:schedule.workspaceId,operationKey:fixture.key}));
  assert.throws(()=>assertRequest('note.deleteCancel',noteRequest));
});

test('all full states retain identity; unsettled work cannot carry an expiry', () => {
  for(const state of ['PENDING','COMMITTING','CANCELLED','DELETED','CONFLICT','FAILED'])
    assertReceipt({...pending,state});
  assertReceipt({...pending,state:'OUTCOME_UNKNOWN',reason:'commitOutcomeUnknown',expiresTickMs:316000});
  for(const state of ['PENDING','COMMITTING'])
    assert.throws(()=>assertReceipt({...pending,state,expiresTickMs:316000}));
  assert.throws(()=>assertReceipt({...pending,state:'OUTCOME_UNKNOWN',reason:'commitOutcomeUnknown'}));
  assert.throws(()=>assertReceipt({...pending,state:'OUTCOME_UNKNOWN',reason:'storageFailure',expiresTickMs:316000}));
  assert.throws(()=>assertReceipt({...pending,content:'body'}));
});

test('unknown lookup is distinct from a full ambiguous receipt and never fake cancellation', () => {
  const unknown={operationKey:fixture.key,state:'UNKNOWN',reason:'unavailable'};
  assertResult('note.deleteCancel',keyed,response(unknown));
  assert.throws(()=>assertResult('note.deleteSchedule',schedule,response(unknown)));
  assert.throws(()=>assertReceipt({...unknown,noteInstanceId:pending.noteInstanceId}));
  assert.throws(()=>assertReceipt({...unknown,reason:'cancelled'}));
  const restarted={...response({...unknown,reason:'previousEpoch'}),epoch:fixture.otherEpoch};
  assertResult('note.deleteCancel',keyed,restarted);
  assert.throws(()=>assertResult('note.deleteCancel',keyed,response({...unknown,reason:'previousEpoch'})));
  assert.throws(()=>assertResult('note.deleteCancel',keyed,{...response(unknown),epoch:fixture.otherEpoch}));
});

test('receipt target and original incarnation cannot silently change', () => {
  assertResult('note.deleteSchedule',schedule,response(pending));
  for(const key of ['workspaceId','noteId','noteInstanceId'])
    assert.throws(()=>assertResult('note.deleteSchedule',schedule,response({...pending,[key]:'replacement'})));
  assert.throws(()=>assertResult('note.deleteCancel',keyed,response({...pending,operationKey:{...fixture.key,nonce:fixture.otherEpoch}})));
  assert.throws(()=>assertResult('note.deleteCancel',keyed,response({...pending,sequence:2})));
});

test('historical receipt can describe an old incarnation without hiding its replacement', () => {
  const current={...identity,noteInstanceId:'replacement'};
  assertResult('note.deleteStatus',keyed,{...status(current),operation:pending});
  assert.throws(()=>assertResult('note.deleteStatus',keyed,{...status(current,[marker()]),operation:pending}));
  assertResult('note.deleteStatus',keyed,{...status(),operation:pending});
  assert.throws(()=>assertResult('note.deleteStatus',keyed,{...status(null,[marker()]),operation:pending}));
  assertResult('note.deleteStatus',noteRequest,status(identity,[marker()]));
});

test('workspace snapshot preserves incarnation-scoped records and denies cancel after claim', () => {
  const second=marker({...pending,noteInstanceId:'replacement'});
  assertResult('note.deleteStatus',{workspaceId:schedule.workspaceId},status(null,[marker(),second]));
  assert.throws(()=>assertResult('note.deleteStatus',{workspaceId:schedule.workspaceId},status(null,[marker(),marker()])));
  for(const state of ['COMMITTING','OUTCOME_UNKNOWN']) {
    const m=marker({...pending,state});assert.equal(m.canCancel,false);
    assertResult('note.deleteStatus',noteRequest,status(identity,[m]));
    assert.throws(()=>assertResult('note.deleteStatus',noteRequest,status(identity,[{...m,canCancel:true}])));
  }
  assert.throws(()=>assertResult('note.deleteStatus',noteRequest,status(identity,[marker({...pending,state:'DELETED'})])));
});

test('256 maximally escaped markers fit the result budget; oversize results are rejected', () => {
  const list=Array.from({length:256},(_,i)=>({...marker(),
    noteId:'\u0000'.repeat(128),noteInstanceId:'\u0000'.repeat(126)+i.toString(16).padStart(2,'0'),
    operationKey:{...fixture.key,issuedTickMs:Number.MAX_SAFE_INTEGER},
    state:'OUTCOME_UNKNOWN',sequence:Number.MAX_SAFE_INTEGER,deadlineTickMs:Number.MAX_SAFE_INTEGER,
    deleteAt:'2026-10-08T15:00:16.123456789Z',canCancel:false}));
  const result={...status(null,list),serverTickMs:Number.MAX_SAFE_INTEGER,sequence:Number.MAX_SAFE_INTEGER};
  assertResult('note.deleteStatus',{workspaceId:schedule.workspaceId},result);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<524288);
  assert.throws(()=>assertResult('note.deleteStatus',{workspaceId:schedule.workspaceId},{...result,pending:[...list,marker()]}));
  assert.throws(()=>assertResult('note.deleteStatus',{workspaceId:schedule.workspaceId},{...result,padding:'x'.repeat(524288)}));
  // The result bound does not invent a global RPC-id bound.
  const frame={jsonrpc:'2.0',id:'x'.repeat(600000),result};
  assert.ok(Buffer.byteLength(JSON.stringify(frame))>524288);
  assert.ok(Buffer.byteLength(JSON.stringify(frame))<40*1024*1024);
  assertResult('note.deleteStatus',{workspaceId:schedule.workspaceId},frame.result);
});

test('events are identity-scoped invalidations and global sequence gaps are legal', () => {
  const event={workspaceId:schedule.workspaceId,noteId:schedule.noteId,noteInstanceId:schedule.noteInstanceId,
    epoch:fixture.epoch,sequence:1,operationKey:fixture.key,state:'PENDING',deadlineTickMs:16000};
  assertEvent(event);assertEvent({...event,sequence:91});
  for(const extra of [{canCancel:true},{content:'body'},{caller:'owner'}])assert.throws(()=>assertEvent({...event,...extra}));
  assert.throws(()=>assertEvent({...event,state:'UNKNOWN'}));
  assert.throws(()=>assertEvent({...event,epoch:fixture.otherEpoch}));
});

test('monotonic countdown subtracts full RTT and cannot be extended by receipt arrival', () => {
  assert.equal(remaining(pending,1000,2000),13000);
  assert.equal(remaining(pending,15900,200),0);
  assert.equal(remaining({...pending,deleteAt:'2099-01-01T00:00:00Z'},1000,2000),13000);
  assert.throws(()=>remaining(pending,1000,-1));
});

test('exact replay never rearms, extends a deadline or repeats a committed effect', () => {
  const trace=new GraceTrace(schedule,fixture.epoch,1000);
  assert.equal(trace.replay({...schedule,undoDelayMs:15000},62000),'PENDING');
  assert.equal(trace.deadline,16000);
  for(const change of [{expectedVersion:8},{sourceRevision:'r:8:1'},{undoDelayMs:16000},{noteId:'other'}])
    assert.throws(()=>trace.replay({...schedule,...change},2000));
  trace.claim(16000);trace.outcome('DELETED');trace.settle(17000);
  assert.equal(trace.replay(schedule,18000),'DELETED');assert.equal(trace.deletions,1);
  assert.throws(()=>trace.outcome('DELETED'));
});

test('cancel-before-claim and claim-before-cancel have different truthful outcomes', () => {
  const cancelled=new GraceTrace(schedule,fixture.epoch,1000);
  assert.equal(cancelled.cancel(),'CANCELLED');assert.equal(cancelled.claim(16000),'CANCELLED');
  cancelled.settle(16000);assert.equal(cancelled.deletions,0);
  const committing=new GraceTrace(schedule,fixture.epoch,1000);
  committing.claim(16000);assert.equal(committing.cancel(),'COMMITTING');
  committing.outcome('DELETED');assert.equal(committing.cancel(),'DELETED');
});

test('physical commit and callback debt never expires or becomes false failure', () => {
  const trace=new GraceTrace(schedule,fixture.epoch,1000);trace.claim(16000);
  assert.equal(trace.expired(1_000_000),false);assert.equal(trace.expiry,null);
  trace.outcome('DELETED');assert.equal(trace.expired(1_000_000),false);
  assert.equal(trace.replay(schedule,1_000_000),'DELETED');
  trace.settle(1_000_001);assert.equal(trace.expiry,1_300_001);
  assert.equal(trace.expired(1_300_000),false);assert.equal(trace.expired(1_300_001),true);
});

test('ambiguous commit is committing until physically settled, then a retained unknown marker', () => {
  const trace=new GraceTrace(schedule,fixture.epoch,1000);trace.claim(16000);
  trace.outcome('OUTCOME_UNKNOWN');assert.equal(trace.state,'COMMITTING');assert.equal(trace.expiry,null);
  assert.equal(trace.cancel(),'COMMITTING');assert.equal(trace.expired(1_000_000),false);
  trace.settle(1_000_001);assert.equal(trace.state,'OUTCOME_UNKNOWN');assert.equal(trace.markerVisible(),true);
  assert.equal(trace.cancel(),'OUTCOME_UNKNOWN');assert.equal(trace.replay(schedule,1_000_002),'OUTCOME_UNKNOWN');
});

test('receipt retention outlives admission and restart never silently rearms an old key', () => {
  const trace=new GraceTrace(schedule,fixture.epoch,1000);trace.cancel();trace.settle(2000);
  assert.equal(trace.replay(schedule,301999),'CANCELLED');
  assert.throws(()=>trace.replay(schedule,302000),/KEY_EXPIRED/);
  assert.throws(()=>new GraceTrace(schedule,fixture.epoch,302000));
  assert.throws(()=>new GraceTrace(schedule,fixture.otherEpoch,1000));
  assert.throws(()=>new GraceTrace(schedule,fixture.epoch,999));
  new GraceTrace(schedule,fixture.epoch,61000);
  assert.throws(()=>new GraceTrace(schedule,fixture.epoch,61001));
});

test('controlled guard and authority failures cannot produce a deletion effect', () => {
  const trace=new GraceTrace(schedule,fixture.epoch,1000);
  assert.throws(()=>trace.replay(schedule,1001,false));assert.throws(()=>trace.cancel(false));
  assert.equal(trace.state,'PENDING');trace.claim(16000);
  assert.throws(()=>trace.outcome('DELETED',{guards:false}));
  assert.throws(()=>trace.outcome('DELETED',{authorized:false}));assert.equal(trace.deletions,0);
  trace.outcome('CONFLICT');trace.settle(17000);assert.equal(trace.deletions,0);
});

test('machine errors match the canonical table without promising absence of older operations', async () => {
  const docs=await read('../../note-delete-grace.md');
  for(const [code,numeric] of Object.entries(fixture.errorCodes))assert.ok(docs.includes(`| ${code} | ${numeric} |`));
  assert.ok(docs.includes('It does not prove a pre-existing'));
  assert.ok(docs.includes('Absence from a newer snapshot retires only the old marker'));
  assert.ok(docs.includes('Comment-only'));
  assert.ok(docs.includes('not total graph bytes'));
});

test('one ambiguous outcome cannot be overwritten before physical settlement', () => {
  const trace=new GraceTrace(schedule,fixture.epoch,1000);trace.claim(16000);
  trace.outcome('OUTCOME_UNKNOWN');
  for(const state of ['DELETED','FAILED','CONFLICT','OUTCOME_UNKNOWN'])assert.throws(()=>trace.outcome(state));
  assert.equal(trace.state,'COMMITTING');assert.equal(trace.deletions,0);
  trace.settle(17000);assert.equal(trace.state,'OUTCOME_UNKNOWN');
});

test('computed deadlines reject safe-integer overflow before constructing a trace', () => {
  const now=Number.MAX_SAFE_INTEGER-14999;
  const request={...schedule,operationKey:{...fixture.key,issuedTickMs:now}};
  assert.throws(()=>new GraceTrace(request,fixture.epoch,now));
  const limit=now-1;
  const trace=new GraceTrace({...request,operationKey:{...fixture.key,issuedTickMs:limit}},fixture.epoch,limit);
  assert.equal(trace.deadline,Number.MAX_SAFE_INTEGER);
});

test('computed expiry rejects overflow without exposing or partially settling an outcome', () => {
  const trace=new GraceTrace(schedule,fixture.epoch,1000);trace.claim(16000);trace.outcome('OUTCOME_UNKNOWN');
  assert.throws(()=>trace.settle(Number.MAX_SAFE_INTEGER-299999));
  assert.equal(trace.state,'COMMITTING');assert.equal(trace.settled,false);assert.equal(trace.expiry,null);
  trace.settle(Number.MAX_SAFE_INTEGER-300000);
  assert.equal(trace.state,'OUTCOME_UNKNOWN');assert.equal(trace.expiry,Number.MAX_SAFE_INTEGER);
  assert.throws(()=>trace.settle(17000));
});
