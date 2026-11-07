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
    args: ['--autoplay-policy=no-user-gesture-required'],
    coverage: ['/repo/dist/'],
    timeout: 120000,
  });
});

after(() => chrome?.close());

async function booted(t) {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  assert.equal(await page.evaluate((f) => window.boot(f), files()), true);
  const sh = (script) =>
    page.evaluate((s) => window.kernel.run(['sh', '-c', s], { cwd: '/tmp' }), script);
  const header = () => page.evaluate(() => window.capture.requests.at(-1));
  return { page, sh, header };
}

const probe = (file) => `mediaprobe -v error -show_format -show_streams -of json ${file}`;

function recorded(stdout, seconds, slack) {
  const { streams, format } = JSON.parse(stdout);
  assert.deepEqual(streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
  const duration = Number(format.duration);
  assert.ok(Math.abs(duration - seconds) <= slack, `duration ${duration}`);
  return streams;
}

it('runs media and mediaprobe on WebCodecs in Chromium', async (t) => {
  const { sh } = await booted(t);

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

it('reads a live MediaRecorder WebM from /dev/embedder as a non-seekable stream', async (t) => {
  const { sh } = await booted(t);
  const header = JSON.stringify({ kind: 'capture.screen', type: 'video/webm', duration: 3 });
  for (const ext of ['mp4', 'webm']) {
    await t.test(`remuxes it to ${ext}`, async (s) => {
      const r = await sh(
        `exec 3<>/dev/embedder && printf '%s\\n' '${header}' >&3 && cat <&3 | media -nostats -y -i - -c copy live.${ext} && mediaprobe -v error -show_format -show_streams -of json live.${ext}`
      );
      assert.equal(r.status, 0, r.stderr);
      const { streams, format } = JSON.parse(r.stdout);
      assert.deepEqual(streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
      const seconds = Number(format.duration);
      assert.ok(Math.abs(seconds - 3) <= 0.3, `duration ${seconds}`);
      s.diagnostic(`${streams.map((x) => x.codec_name).join('+')}, ${seconds} s`);
    });
  }
});

it('captures the screen through capture.screen with media itself', async (t) => {
  const { page, sh, header } = await booted(t);

  await t.test('records -t 2 into an mp4, with the cursor, and passes progress on', async () => {
    const r = await sh(
      `media -nostats -y -f avfoundation -capture_cursor 1 -framerate 30 -i "Capture screen 0" -t 2 out.mp4 && ${probe('out.mp4')}`
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^media: recording…\n/);
    recorded(r.stdout, 2, 0.2);
    assert.deepEqual(await header(), {
      type: 'video/webm',
      surface: 'monitor',
      cursor: 'always',
      duration: 2,
    });
  });

  await t.test('transcodes a live capture through WebCodecs', async () => {
    const r = await sh(
      `media -nostats -y -f x11grab -i :0.0 -t 1.5 -c:v libvpx -vf scale=160:-2 -c:a libopus small.webm && ${probe('small.webm')}`
    );
    assert.equal(r.status, 0, r.stderr);
    const [video] = recorded(r.stdout, 1.5, 0.2);
    assert.equal(video.codec_name, 'vp8');
    assert.equal(video.width, 160);
  });

  await t.test('writes a still as the page encoded it', async () => {
    const r = await sh(
      'media -y -f gdigrab -i title=Editor -frames:v 1 shot.png && od -A n -t x1 -N 8 shot.png'
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '89 50 4e 47 0d 0a 1a 0a');
    assert.deepEqual(await header(), { type: 'image/png', surface: 'window' });
  });

  await t.test('finalizes the file on ^C when there is no -t, and exits 255', async () => {
    const r = await sh(
      `media -nostats -y -f avfoundation -i 0 live.webm & pid=$!; sleep 2; kill -INT $pid; wait $pid; echo status=$?; ${probe('live.webm')}`
    );
    assert.match(r.stdout, /^status=255\n/, r.stderr);
    assert.match(r.stderr, /Exiting normally, received signal 2\.\n$/);
    recorded(r.stdout.replace(/^status=255\n/, ''), 2, 1);
    assert.equal((await header()).duration, undefined);
  });

  await t.test('ends normally when the page ends the capture', async () => {
    const r = await page.evaluate(
      async (script) => {
        const run = window.kernel.run(['sh', '-c', script], { cwd: '/tmp' });
        while (window.capture.live.size === 0) await new Promise((ok) => setTimeout(ok, 50));
        await new Promise((ok) => setTimeout(ok, 1500));
        for (const capture of window.capture.live) capture.end();
        return run;
      },
      `media -nostats -y -f gdigrab -i desktop ended.mkv && ${probe('ended.mkv')}`
    );
    assert.equal(r.status, 0, r.stderr);
    recorded(r.stdout, 1.5, 0.75);
  });

  await t.test('says what a refusal means and exits 1', async () => {
    await page.evaluate(() => {
      window.capture.refuse = 'Permission denied by user';
    });
    const r = await sh('media -nostats -y -f avfoundation -i 0 -t 1 refused.mp4');
    await page.evaluate(() => {
      window.capture.refuse = null;
    });
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      'media: user cancelled, permission denied, or the surface is protected\n'
    );
  });
});
