import test from 'node:test';
import assert from 'node:assert/strict';
import {randomOrder, nextShuffleSeed} from '../src/randomOrder.ts';
const pictures=Array.from({length:80},(_,i)=>({path:`/photos/image-${i}.jpg`,name:`image-${i}.jpg`,modifiedMs:i}));
const paths=(items)=>items.map(item=>item.path);

test('random order is a deterministic permutation and does not mutate its input',()=>{
  const before=structuredClone(pictures);
  const ordered=randomOrder(pictures,12345);
  assert.deepEqual(pictures,before);
  assert.deepEqual([...paths(ordered)].sort(),paths(pictures).sort());
  assert.deepEqual(ordered,randomOrder([...pictures].reverse(),12345));
  assert.notDeepEqual(paths(ordered),paths(randomOrder(pictures,54321)));
  assert.deepEqual(ordered,randomOrder(pictures,JSON.parse(JSON.stringify(12345))));
});

test('metadata refreshes, filters and new files preserve the relative order of existing files',()=>{
  const original=paths(randomOrder(pictures,42));
  const refreshed=pictures.map((item,i)=>({...item,modifiedMs:10000-i,name:'changed'}));
  assert.deepEqual(paths(randomOrder(refreshed,42)),original);
  const included=new Set(paths(pictures.filter((_,i)=>i%2===0)));
  assert.deepEqual(paths(randomOrder(pictures.filter(p=>included.has(p.path)),42)),original.filter(p=>included.has(p)));
  assert.deepEqual(paths(randomOrder([...pictures,{path:'/new.jpg'}],42)).filter(p=>p!=='/new.jpg'),original);
});

test('empty/singleton galleries and all allowed seed boundaries work',()=>{
  for(const seed of [0,0xffffffff]) {
    assert.deepEqual(randomOrder([],seed),[]);
    assert.deepEqual(randomOrder(pictures.slice(0,1),seed),pictures.slice(0,1));
    const next=nextShuffleSeed(seed);
    assert.ok(Number.isInteger(next)&&next>=0&&next<=0xffffffff);
    assert.notEqual(next,seed);
  }
});
