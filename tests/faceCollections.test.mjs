import test from 'node:test';
import assert from 'node:assert/strict';
import {FACE_COLLECTIONS_PREFERENCE, faceScope, faceCollectionFor, readFaceCollections, updateFaceCollection, validFaceCollections} from '../src/faceCollections.ts';
const preferences = (values) => ({getItem: (key) => values[key] ?? null});
const legacy = {'inpaint.faceLibrary':JSON.stringify(['/one.png','/two.png','/one.png']), 'inpaint.faceSourcePath':JSON.stringify('/two.png')};

test('legacy choices migrate only into the current store; fresh stores start empty', () => {
  const collections=readFaceCollections(preferences(legacy),'a');
  assert.deepEqual(faceCollectionFor(collections,faceScope('a')), {scope:'store:a',paths:['/one.png','/two.png'],sourcePath:'/two.png'});
  assert.deepEqual(faceCollectionFor(collections,faceScope('b')).paths, []);
  assert.equal(faceCollectionFor(collections,faceScope('b')).sourcePath, '');
  assert.deepEqual(faceCollectionFor(collections,faceScope(null)).paths, []);
});

test('folder choices use a separate scope, even if a store is named folders', () => {
  const collections=readFaceCollections(preferences(legacy),null);
  assert.equal(faceCollectionFor(collections,faceScope(null)).sourcePath,'/two.png');
  assert.equal(faceCollectionFor(collections,faceScope('folders')).sourcePath,'');
});

test('updates and delayed callbacks retain their original store and preserve other stores', () => {
  let collections=readFaceCollections(preferences(legacy),'a');
  const before=structuredClone(collections[0]);
  collections=updateFaceCollection(collections,faceScope('b'),c=>({...c,paths:['/blue.png'],sourcePath:'/blue.png'}));
  collections=updateFaceCollection(collections,faceScope('a'),c=>({...c,paths:[...c.paths,'/late.png']}));
  assert.equal(faceCollectionFor(collections,faceScope('b')).sourcePath,'/blue.png');
  collections=updateFaceCollection(collections,faceScope('b'),c=>({...c,paths:[],sourcePath:''}));
  assert.deepEqual(faceCollectionFor(collections,faceScope('a')), {...before,paths:[...before.paths,'/late.png']});
  const reopened=readFaceCollections(preferences({...legacy,[FACE_COLLECTIONS_PREFERENCE]:JSON.stringify(collections)}),'b');
  assert.deepEqual(reopened,collections);
  assert.deepEqual(faceCollectionFor(reopened,faceScope('b')).paths,[]);
});

test('empty saved collections do not re-import legacy data', () => {
  assert.deepEqual(readFaceCollections(preferences({...legacy,[FACE_COLLECTIONS_PREFERENCE]:'[]'}),'b'),[]);
});

test('malformed legacy preferences are tolerated and source-only selections are preserved', () => {
  assert.deepEqual(readFaceCollections(preferences({'inpaint.faceLibrary':'broken'}),'a'),[]);
  assert.deepEqual(readFaceCollections(preferences({'inpaint.faceSourcePath':'"/source.png"'}),'a')[0].paths,['/source.png']);
  assert.equal(validFaceCollections([{scope:'a',paths:[42],sourcePath:''}]),false);
  assert.equal(validFaceCollections([{scope:'a',paths:[],sourcePath:''},{scope:'a',paths:[],sourcePath:''}]),false);
});
