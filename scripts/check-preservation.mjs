import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

function content(html) {
  const data = {};
  for (const name of ['memberData', 'liveData', 'albums']) {
    const match = html.match(new RegExp('let ' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\n\\});'));
    if (!match) throw new Error('Missing bundled ' + name);
    data[name] = JSON.parse(match[1]);
  }
  return data;
}
async function fingerprint(value) {
  if (typeof value === 'string') {
    let bytes;
    if (value.startsWith('data:image/')) bytes = Buffer.from(value.split(',')[1], 'base64');
    else if (value.startsWith('assets/bundled/')) bytes = await readFile(value);
    return bytes ? 'sha256:' + createHash('sha256').update(bytes).digest('hex') : value;
  }
  if (Array.isArray(value)) return Promise.all(value.map(fingerprint));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = await fingerprint(item);
    return result;
  }
  return value;
}
const original = content(await readFile(process.argv[2], 'utf8'));
const updated = content(await readFile('index.html', 'utf8'));
assert.deepEqual(await fingerprint(updated), await fingerprint(original));
console.log(JSON.stringify({ preserved: true, members: Object.keys(updated.memberData).length,
  lives: Object.keys(updated.liveData).length, albums: Object.keys(updated.albums).length,
  photos: Object.values(updated.albums).reduce((sum, album) => sum + album.photos.length, 0) }));
