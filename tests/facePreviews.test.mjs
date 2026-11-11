import test from 'node:test';
import assert from 'node:assert/strict';
import {FacePreviewSet, adjacentFacePreview} from '../src/facePreviews.ts';

const settings = {strength:0.6,colorMatch:0.2,target:[0.3,0.4]};
const noop=()=>{};

test('switching donors and previewing the whole set always starts from the baseline; cached faces are reused', async () => {
  const calls=[]; const releases=[];
  const options=structuredClone(settings);
  const set=new FacePreviewSet('original pixels',options,async(data,operation)=>{
    calls.push({data,operation});return {src:operation.donor,release:()=>releases.push(operation.donor)};
  });
  options.target[0]=0.9;
  await set.generate(['one'],noop);
  await set.generate(['two'],noop);
  await set.generate(['one','two','three','three'],noop);
  assert.deepEqual(calls.map(c=>c.data),['original pixels','original pixels','original pixels']);
  assert.deepEqual(calls.map(c=>c.operation.donor),['one','two','three']);
  assert.deepEqual(calls[2].operation.target,[0.3,0.4]);
  assert.equal(calls[2].operation.strength,0.6);
  set.dispose(); set.dispose();
  assert.deepEqual(releases,['one','two','three']); assert.equal(set.results.size,0);
});

test('one bad donor does not prevent later candidates, and can be retried', async () => {
  let fail=true;
  const set=new FacePreviewSet('base',settings,async(_data,operation)=>{
    if(operation.donor==='bad'&&fail) throw Error('No face detected');
    return {src:operation.donor,release:noop};
  });
  await set.generate(['bad','good'],noop);
  assert.equal(set.results.size,1);assert.match(set.errors.get('bad'),/No face/);
  fail=false;await set.generate(['bad'],noop);
  assert.equal(set.errors.size,0);assert.equal(set.results.size,2);set.dispose();
});

test('discard during generation releases the late result and does not run remaining faces', async () => {
  let finish;let released=0;let calls=0;
  const set=new FacePreviewSet('base',settings,async()=>{calls++;await new Promise(r=>finish=r);return {src:'late',release:()=>released++};});
  const pending=set.generate(['one','two'],noop);
  set.dispose();finish();await pending;
  assert.equal(released,1);assert.equal(calls,1);assert.equal(set.results.size,0);
});

test('stop keeps completed candidates and prevents another concurrent run', async () => {
  let finish;let calls=0;
  const set=new FacePreviewSet('base',settings,async()=>{calls++;await new Promise(r=>finish=r);return {src:'done',release:noop};});
  const pending=set.generate(['one','two'],noop);
  await set.generate(['three'],noop);
  set.stop();finish();await pending;
  assert.equal(calls,1);assert.equal(set.results.size,1);assert.ok(set.results.has('one'));set.dispose();
});


test('preview navigation wraps, enters from Original, and tolerates an empty or changing list', () => {
  const results = [{donor:'one'}, {donor:'two'}, {donor:'three'}];
  assert.equal(adjacentFacePreview(results, null, 1), 'one');
  assert.equal(adjacentFacePreview(results, null, -1), 'three');
  assert.equal(adjacentFacePreview(results, 'one', -1), 'three');
  assert.equal(adjacentFacePreview(results, 'three', 1), 'one');
  assert.equal(adjacentFacePreview(results, 'one', 1), 'two');
  assert.equal(adjacentFacePreview(results, 'two', -1), 'one');
  assert.equal(adjacentFacePreview([], null, 1), null);
  assert.equal(adjacentFacePreview(results.slice(0,1), 'one', 1), 'one');
  assert.equal(adjacentFacePreview(results, 'removed', -1), 'three');
});


test('parallel previews use at most two independent lanes, keep baseline/settings and count out-of-order completions', async () => {
  const pending = new Map(), calls = [], progress = [];
  const set = new FacePreviewSet('base', settings, async (data, operation, lane) => {
    calls.push({data, operation, lane});
    await new Promise(resolve => pending.set(operation.donor, resolve));
    return {src: operation.donor, release: noop};
  });
  const run = set.generate(['one','two','three','four','two'], p => progress.push({...p}), 2);
  assert.deepEqual(calls.map(c => [c.operation.donor,c.lane]), [['one',0],['two',1]]);
  pending.get('two')(); await new Promise(setImmediate);
  assert.deepEqual(calls.map(c => [c.operation.donor,c.lane]), [['one',0],['two',1],['three',1]]);
  pending.get('one')(); await new Promise(setImmediate);
  assert.equal(calls[3].lane,0);
  pending.get('four')(); pending.get('three')(); await run;
  assert.deepEqual(progress.filter((p,i) => i===0 || p.done !== progress[i-1].done).map(p=>p.done),[0,1,2,3,4]);
  assert.equal(progress.at(-1).total,4);
  assert.ok(calls.every(c => c.data === 'base' && c.operation.strength === settings.strength));
  assert.equal(set.results.size,4); set.dispose();
});

for (const action of ['stop', 'dispose']) test(`${action} drains both parallel lanes without scheduling more faces`, async () => {
  const finishes = [], released = [];
  const set = new FacePreviewSet('base',settings,async (_data,operation) => {
    await new Promise(resolve => finishes.push(resolve));
    return {src:operation.donor,release:()=>released.push(operation.donor)};
  });
  const run = set.generate(['one','two','three','four'],noop,2);
  assert.equal(finishes.length,2); set[action]();
  finishes.forEach(finish=>finish()); await run;
  assert.equal(finishes.length,2);
  assert.equal(set.results.size,action==='stop'?2:0);
  set.dispose(); assert.deepEqual(released.sort(),['one','two']);
});

test('a failed parallel donor does not cancel the other lane or remaining candidates', async () => {
  const set = new FacePreviewSet('base',settings,async(_data,operation)=>{
    if(operation.donor==='bad') throw Error('No face');
    return {src:operation.donor,release:noop};
  });
  await set.generate(['bad','two','three'],noop,2);
  assert.deepEqual([...set.results.keys()].sort(),['three','two']);
  assert.match(set.errors.get('bad'),/No face/); set.dispose();
});
