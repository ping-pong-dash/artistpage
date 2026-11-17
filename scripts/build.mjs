import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await copyFile('index.html', 'dist/index.html');
await copyFile('shared-content.js', 'dist/shared-content.js');
await cp('assets', 'dist/assets', { recursive: true });
console.log('Built site in dist/ (server code and secrets excluded).');
