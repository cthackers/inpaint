import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSmartRules, matchesSmartAlbum, smartAlbumView, validSmartAlbums} from '../src/smartAlbums.ts';

const now = 1800000000000;
const image = {path:'/photos/a.jpg',name:'Paris portrait.JPG',extension:'jpg',size:100,modifiedMs:now - 2 * 86400000};
const rule = (changes) => ({...structuredClone(defaultSmartRules),...changes});
const matches = (rules, tags = [], facts) => matchesSmartAlbum(image,rule(rules),tags,facts,now);

test('all/any tag lists, exclusions, exact and hierarchical tags', () => {
  assert.equal(matches({tags:['Travel','People']},['Travel/Paris','People']),true);
  assert.equal(matches({tags:['Travel','People']},['Travel/Paris']),false);
  assert.equal(matches({tags:['Travel','People'],tagMatch:'any'},['People']),true);
  assert.equal(matches({tags:['Travel']},[]),false);
  assert.equal(matches({tags:['Travel'],descendants:false},['Travel/Paris']),false);
  assert.equal(matches({tags:['Travel']},['Travelling']),false);
  assert.equal(matches({tags:['Travel'],excludeTags:['Private']},['travel/paris','Private/Family']),false);
  assert.equal(matches({tags:[],tagMatch:'any'},[]),true);
});

test('combined categories, unrated defaults, format aliases and date boundary', () => {
  const rules = {tags:['Portrait'],favorite:'yes',minRating:4,maxRating:5,name:'PARIS',formats:['jpeg'],addedDays:7};
  assert.equal(matches(rules,['portrait'],{favorite:true,rating:4}),true);
  assert.equal(matches(rules,['portrait'],{favorite:false,rating:4}),false);
  assert.equal(matches(rules,['portrait'],{favorite:true,rating:3}),false);
  assert.equal(matches({maxRating:0},[],undefined),true);
  assert.equal(matches({favorite:'no'},[],undefined),true);
  assert.equal(matches({addedDays:1}),false);
  assert.equal(matches({addedDays:2}),true);
  assert.equal(matches({addedDays:1},[],{favorite:false,rating:0,addedMs:now}),true);
  assert.equal(matches({addedDays:1},[],{favorite:false,rating:0,addedMs:now+1}),false);
});

test('counts and cover update when tags change without changing source images', () => {
  const album = {id:'smart:1',storeId:'s',name:'Portraits',createdMs:now,rules:rule({tags:['Portrait']})};
  const images = [image,{...image,path:'/photos/b.jpg',modifiedMs:now}];
  const first = smartAlbumView(album,images,{[image.path]:['Portrait']},{},now);
  assert.equal(first.total,1); assert.equal(first.coverPath,image.path);
  const next = smartAlbumView(album,images,Object.fromEntries(images.map(i=>[i.path,['Portrait']])),{},now);
  assert.equal(next.total,2); assert.equal(next.coverPath,'/photos/b.jpg');
  assert.equal(images.length,2); assert.equal(validSmartAlbums([album]),true);
  assert.equal(validSmartAlbums([{...album,rules:{...album.rules,tags:null}}]),false);
  assert.equal(validSmartAlbums([{...album,rules:{...album.rules,minRating:5,maxRating:2}}]),false);
});
