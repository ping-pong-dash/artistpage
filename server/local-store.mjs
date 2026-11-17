import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './security.mjs';

export function localStore(directory) {
  let serial = Promise.resolve();
  const current = async () => {
    try { return JSON.parse(await readFile(join(directory, 'content.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  return async (action, payload) => {
    await mkdir(join(directory, 'images'), { recursive: true });
    await mkdir(join(directory, 'history'), { recursive: true });
    if (action === 'read') return { content: await current() };
    if (action === 'image') {
      try { return { base64: await readFile(join(directory, 'images', payload.key), 'base64') }; }
      catch (error) { if (error.code === 'ENOENT') throw fail(404, '写真が見つかりません。'); throw error; }
    }
    if (action === 'upload') {
      await writeFile(join(directory, 'images', payload.key), Buffer.from(payload.base64, 'base64'), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      return { key: payload.key };
    }
    if (action === 'save') {
      const save = serial.then(async () => {
        const existing = await current();
        if ((existing?.revision || null) !== payload.expectedRevision) throw fail(409, 'ほかのメンバーの更新があります。下書きを書き出してから再読み込みしてください。');
        const content = { schemaVersion: 1, revision: randomUUID(), updatedAt: new Date().toISOString(), data: payload.data };
        const serialized = JSON.stringify(content);
        await writeFile(join(directory, 'history', content.revision + '.json'), serialized);
        const temporary = join(directory, content.revision + '.tmp');
        await writeFile(temporary, serialized);
        await rename(temporary, join(directory, 'content.json'));
        return { revision: content.revision, updatedAt: content.updatedAt };
      });
      serial = save.catch(() => {});
      return save;
    }
    throw fail(400, 'Unknown action.');
  };
}
