import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const code = await readFile('google-apps-script/Code.gs', 'utf8');
function fixture() {
  const properties = new Map();
  const folders = new Map(), files = new Map();
  const iterator = values => { let i = 0; return { hasNext: () => i < values.length, next: () => values[i++] }; };
  const blob = (value, mime, name) => {
    const bytes = Buffer.isBuffer(value) ? value : Array.isArray(value) ? Buffer.from(value) : Buffer.from(String(value));
    return { name, mime, getBytes: () => [...bytes], getDataAsString: () => bytes.toString('utf8') };
  };
  function folder(id = randomUUID()) {
    const own = [];
    const result = {
      getId: () => id, getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      createFolder: () => folder(),
      createFile: value => {
        const fileId = randomUUID();
        const file = { getId: () => fileId, getBlob: () => value, getParents: () => iterator([result]), name: value.name };
        own.push(file); files.set(fileId, file); return file;
      },
      getFilesByName: name => iterator(own.filter(file => file.name === name))
    };
    folders.set(id, result);
    return result;
  }
  folder('1ObCpREIQIO_UZ64P_s-4fM-O364gx7s0');
  const context = vm.createContext({
    console: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || null, setProperty: (key, value) => properties.set(key, value) }) },
    DriveApp: { getFolderById: id => folders.get(id), getFileById: id => files.get(id) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      getUuid: randomUUID, newBlob: blob,
      base64Decode: text => [...Buffer.from(text, 'base64')],
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      computeHmacSha256Signature: (message, secret) => [...createHmac('sha256', secret).update(message).digest()],
      computeDigest: (_, bytes) => [...createHash('sha256').update(Buffer.from(bytes)).digest()],
      DigestAlgorithm: { SHA_256: 'SHA_256' }
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => text }) }
  });
  vm.runInContext(code, context);
  context.setup();
  const invoke = (action, payload = {}, timestamp = Date.now()) => {
    const message = JSON.stringify({ action, payload, timestamp });
    const signature = createHmac('sha256', properties.get('SHARED_SECRET')).update(message).digest('hex');
    return JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ message, signature }) } }));
  };
  return { context, invoke, properties, files, folders };
}

test('Apps Script rejects unsigned and expired requests', () => {
  const { context, invoke } = fixture();
  const bad = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ message: '{}', signature: 'wrong' }) } }));
  assert.equal(bad.status, 403);
  assert.equal(invoke('read', {}, Date.now() - 360000).status, 403);
});

test('Drive snapshots are immutable and stale saves do not replace the head', () => {
  const { invoke, files } = fixture();
  const data = { memberData: { nami: {} }, liveData: {}, albums: {} };
  assert.equal(invoke('read').data.content, null);
  const first = invoke('save', { data, expectedRevision: null });
  assert.equal(first.ok, true);
  const second = invoke('save', { data: { ...data, liveData: { live: { title: 'New live' } } }, expectedRevision: first.data.revision });
  assert.equal(second.ok, true);
  const conflict = invoke('save', { data, expectedRevision: first.data.revision });
  assert.equal(conflict.status, 409);
  assert.equal(invoke('read').data.content.revision, second.data.revision);
  assert.equal(files.size, 2);
});

test('Drive images are deduplicated and can be read byte-for-byte', async () => {
  const { invoke, files } = fixture();
  const bytes = await readFile('assets/logos/band-logo.jpg');
  const key = createHash('sha256').update(bytes).digest('hex');
  const payload = { key, mime: 'image/jpeg', base64: bytes.toString('base64') };
  assert.equal(invoke('upload', payload).ok, true);
  assert.equal(invoke('upload', payload).ok, true);
  assert.equal(files.size, 1);
  assert.deepEqual(Buffer.from(invoke('image', { key }).data.base64, 'base64'), bytes);
  assert.equal(invoke('image', { key: '../private' }).status, 400);
});

test('setup is repeatable and retains the supplied root folder and secret', () => {
  const { context, properties, folders } = fixture();
  const secret = properties.get('SHARED_SECRET');
  context.setup();
  assert.equal(properties.get('ROOT_FOLDER_ID'), '1ObCpREIQIO_UZ64P_s-4fM-O364gx7s0');
  assert.equal(properties.get('SHARED_SECRET'), secret);
  assert.equal(folders.size, 3);
});
