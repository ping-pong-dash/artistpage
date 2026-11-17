import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const script = await readFile('shared-content.js', 'utf8');
const mergeSource = script.slice(script.indexOf('  function listKey'), script.indexOf('  async function imageSource'));
const context = vm.createContext({ structuredClone });
vm.runInContext('const clone = structuredClone;\n' + mergeSource + '\nthis.mergeData = merge;', context);
const merge = (a, b, overwrite) => JSON.parse(JSON.stringify(context.mergeData(a, b, overwrite)));
const base = () => ({ memberData: { nami: { name: 'NAMi' } }, liveData: {}, albums: {
  first: { title: 'Existing album', coverIndex: 0, photos: [{ src: 'a.jpg', comment: 'original' }, { src: 'b.jpg', comment: 'second' }] }
} });

test('initial migration retains legacy comments and remaps the selected cover without losing photos', () => {
  const legacy = { albums: { first: { title: 'Legacy title', coverIndex: 0, photos: [
    { src: 'b.jpg', comment: 'Edited in browser' }, { src: 'c.jpg', comment: 'Legacy addition' }
  ] } } };
  const merged = merge(base(), legacy, true);
  assert.equal(merged.albums.first.title, 'Legacy title');
  assert.equal(merged.albums.first.photos.length, 3);
  assert.equal(merged.albums.first.photos[1].comment, 'Edited in browser');
  assert.equal(merged.albums.first.coverIndex, 1);
});

test('later imports add missing data but retain already published fields and captions', () => {
  const legacy = { liveData: { next: { title: 'Another live' } }, albums: { first: {
    title: 'Old title', photos: [{ src: 'a.jpg', comment: 'Old comment' }, { src: 'c.jpg' }]
  } } };
  const merged = merge(base(), legacy, false);
  assert.equal(merged.albums.first.title, 'Existing album');
  assert.equal(merged.albums.first.photos[0].comment, 'original');
  assert.equal(merged.albums.first.photos.length, 3);
  assert.equal(merged.liveData.next.title, 'Another live');
});

test('migration rejects object prototype keys', () => {
  assert.throws(() => merge(base(), JSON.parse('{"albums":{"__proto__":{"title":"bad"}}}')));
});
