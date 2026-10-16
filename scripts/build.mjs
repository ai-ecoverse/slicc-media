#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const mediabunny = join(root, 'node_modules/mediabunny');
const mb = JSON.parse(readFileSync(join(mediabunny, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(dist, 'media.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2024'],
  minify: true,
  legalComments: 'none',
  banner: {
    js: `/* @ai-ecoverse/slicc-media ${pkg.version}, Apache-2.0. Bundles mediabunny ${mb.version} (MPL-2.0, https://github.com/Vanilagy/mediabunny), unmodified; its licence is dist/mediabunny-LICENSE. */`,
  },
  define: {
    MEDIA_VERSION: JSON.stringify(pkg.version),
    MEDIABUNNY_VERSION: JSON.stringify(mb.version),
  },
  logLevel: 'info',
});

copyFileSync(join(mediabunny, 'LICENSE'), join(dist, 'mediabunny-LICENSE'));
