// Builds preview/out/index.html: the dashboard (src/app.html) with example data and a
// fake API (preview/demo.ts), so the design can be opened in any browser.
// --artifact also writes preview/out/artifact.html without the document wrapper.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const { outputFiles } = await build({ entryPoints: ['preview/demo.ts'], bundle: true, write: false, format: 'iife', target: 'es2020' });
const shim = `<script>${outputFiles[0].text}</script>`;
const html = readFileSync('src/app.html', 'utf8').replace(/<script src="https:\/\/telegram\.org[^>]*><\/script>/, () => shim);

mkdirSync('preview/out', { recursive: true });
writeFileSync('preview/out/index.html', html);
console.log('wrote preview/out/index.html');

if (process.argv.includes('--artifact')) {
  const page = html
    .replace(/<!doctype html>\s*<html[^>]*>\s*<head>/i, '')
    .replace(/<meta charset="utf-8">\s*<meta name="viewport"[^>]*>/, '')
    .replace(/<title>Money<\/title>/, '<title>Money Mini App</title>')
    .replace(/<\/head>\s*<body>/, '')
    .replace(/<\/body>\s*<\/html>\s*$/, '');
  writeFileSync('preview/out/artifact.html', page);
  console.log('wrote preview/out/artifact.html');
}
