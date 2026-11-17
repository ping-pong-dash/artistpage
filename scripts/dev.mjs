import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { handle } from '../server/api.mjs';
import { configuration } from '../server/gateway.mjs';
import { localStore } from '../server/local-store.mjs';

const root = process.cwd();
const local = localStore(resolve(root, '.local-data'));
const configured = configuration();
const options = configured.configured ? {} : {
  gateway: local,
  configuration: { configured: true, password: 'local-preview-only', sessionSecret: randomBytes(32).toString('hex') }
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = createServer(async (incoming, outgoing) => {
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const url = new URL(incoming.url, origin);
    let response;
    const match = url.pathname.match(/^\/\.netlify\/functions\/site-(session|content|media)$/);
    if (match) {
      const req = new Request(url, { method: incoming.method, headers: incoming.headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: incoming, duplex: 'half' }) });
      response = await handle(req, match[1], options);
    } else {
      const relative = decodeURIComponent(url.pathname.slice(1) || 'index.html');
      const file = resolve(root, relative);
      if (!(relative === 'index.html' || relative === 'shared-content.js' || relative.startsWith('assets/')) || !file.startsWith(root + '\\') && !file.startsWith(root + '/')) {
        response = new Response('Not found', { status: 404 });
      } else if (!(await stat(file)).isFile()) response = new Response('Not found', { status: 404 });
      else response = new Response(await readFile(file), { headers: { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' } });
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(incoming.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(error.code === 'ENOENT' ? 404 : 500);
    outgoing.end('Request failed');
  }
});
server.listen(Number(process.env.PORT || 8001), '127.0.0.1', () => {
  console.log('Local site: http://127.0.0.1:' + server.address().port);
  console.log(configured.configured ? 'Google Drive connected.' : 'Preview saves to .local-data only. Preview password: local-preview-only');
});
