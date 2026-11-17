import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// A lossless, one-time migration: identical image bytes keep identical filenames.
const input = await readFile('index.html', 'utf8');
const images = new Map();
const output = input.replace(/data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)/g, (_, type, base64) => {
  const bytes = Buffer.from(base64, 'base64');
  const key = createHash('sha256').update(bytes).digest('hex');
  const file = 'assets/bundled/' + key + '.' + (type === 'jpeg' ? 'jpg' : type);
  images.set(file, bytes);
  return file;
});
await mkdir('assets/bundled', { recursive: true });
for (const [file, bytes] of images) await writeFile(file, bytes);
if (output !== input) await writeFile('index.html', output);
console.log('Extracted ' + images.size + ' unique images without recompression.');
