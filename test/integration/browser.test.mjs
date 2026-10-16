import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { after, before, it } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const root = resolve(import.meta.dirname, '../..');

function walk(dir, out = []) {
  if (!statSync(dir).isDirectory()) {
    out.push(dir);
    return out;
  }
  for (const name of readdirSync(dir)) walk(join(dir, name), out);
  return out;
}

function files() {
  const list = [];
  for (const name of ['@ai-ecoverse/wasm-bash', '@ai-ecoverse/wasm-coreutils']) {
    for (const path of walk(join(root, 'node_modules', name))) {
      const rel = relative(root, path);
      list.push([`/repo/${rel}`, `/${rel}`]);
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const own = [join(root, 'package.json'), ...pkg.files.flatMap((f) => walk(join(root, f)))];
  for (const path of own) {
    const rel = relative(root, path);
    list.push([`/repo/${rel}`, `/node_modules/${pkg.name}/${rel}`]);
  }
  for (const name of readdirSync(join(root, 'test/integration/fixtures'))) {
    list.push([`/repo/test/integration/fixtures/${name}`, `/tmp/${name}`]);
  }
  return list;
}

let chrome;

before(async () => {
  chrome = await launch({
    roots: [
      ['/kernel/', 'node_modules/@ai-ecoverse/slicc-kernel/dist/'],
      ['/repo/', './'],
      ['/', 'test/integration/page/'],
    ],
    isolated: true,
    coverage: ['/repo/dist/'],
    timeout: 120000,
  });
});

after(() => chrome?.close());

it('runs media and mediaprobe on WebCodecs in Chromium', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  assert.equal(await page.evaluate((f) => window.boot(f), files()), true);
  const sh = (script) =>
    page.evaluate((s) => window.kernel.run(['sh', '-c', s], { cwd: '/tmp' }), script);

  await t.test('lists the browser encoders, VP8, VP9 and Opus among them', async () => {
    const r = await sh('media -encoders');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, / V libvpx +vp8\n/);
    assert.match(r.stdout, / V libvpx-vp9 +vp9\n/);
    assert.match(r.stdout, / A libopus +opus\n/);
  });

  await t.test('re-encodes VP9 to VP8 and scales it in the process worker', async () => {
    const r = await sh(
      'media -nostats -i clip.webm -c:v libvpx -vf scale=80:-2,fps=5 -c:a libopus out.webm && mediaprobe -v error -show_streams -count_packets -of json out.webm'
    );
    assert.equal(r.status, 0, r.stderr);
    const [video, audio] = JSON.parse(r.stdout).streams;
    assert.equal(video.codec_name, 'vp8');
    assert.equal(video.width, 80);
    assert.equal(video.height, 60);
    assert.equal(video.nb_read_packets, '5');
    assert.equal(audio.codec_name, 'opus');
  });

  await t.test('decodes Opus to a WAV file', async () => {
    const r = await sh(
      'media -nostats -y -i tone.ogg -c:a pcm_s16le -ar 48000 tone.wav && mediaprobe -show_entries stream=codec_name,sample_rate -of csv=p=0 tone.wav'
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'pcm_s16le,48000\n');
  });

  await t.test('pipes an encode into a probe', async () => {
    const r = await sh(
      'media -nostats -i clip.webm -an -c:v libvpx-vp9 -b:v 100k -f webm - | mediaprobe -show_entries stream=codec_name -of csv=p=0 -'
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'vp9\n');
  });

  await t.test(
    'transcodes H.264 if this browser decodes it, and says why not if not',
    async (s) => {
      const decoders = await sh('media -decoders');
      const r = await sh('media -nostats -y -i clip.mp4 -an -c:v libvpx h264.webm');
      if (/ V libx264 /.test(decoders.stdout)) {
        assert.equal(r.status, 0, r.stderr);
        s.diagnostic('this browser decodes H.264');
      } else {
        assert.equal(r.status, 1);
        assert.match(r.stderr, /no decoder for 'h264' \(this browser has none\)/);
      }
    }
  );
});
