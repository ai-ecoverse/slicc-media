import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { boot } from './kernel.mjs';

let os;

before(async () => {
  os = await boot();
});

after(() => os?.close());

const sh = (script) => os.sh(script);

const mediabunny = JSON.parse(
  readFileSync(new URL('../../node_modules/mediabunny/package.json', import.meta.url), 'utf8')
).version;

const NO_WEBCODECS =
  'WebCodecs is not available in this runtime; probing, stream copy (-c copy) and PCM work, re-encoding needs a browser';

describe('mediaprobe on the Node kernel', () => {
  it('is installed as a command next to media', async () => {
    const r = await sh('command -v media mediaprobe');
    assert.equal(r.stdout, '/usr/bin/media\n/usr/bin/mediaprobe\n');
  });

  it('prints ffprobe-shaped JSON for a webm, packets counted', async () => {
    const r = await sh(
      'mediaprobe -v error -show_streams -show_format -count_packets -of json clip.webm'
    );
    assert.equal(r.status, 0, r.stderr);
    const { streams, format } = JSON.parse(r.stdout);
    assert.deepEqual(
      streams.map((s) => [s.codec_type, s.codec_name, s.nb_read_packets]),
      [
        ['video', 'vp9', '10'],
        ['audio', 'opus', '51'],
      ]
    );
    assert.equal(streams[0].width, 160);
    assert.equal(streams[0].r_frame_rate, '10/1');
    assert.equal(streams[1].channel_layout, 'mono');
    assert.equal(format.format_name, 'matroska,webm');
    assert.equal(format.size, '10530');
    assert.equal(format.nb_streams, 2);
  });

  it('probes H.264 and AAC without decoding them', async () => {
    const r = await sh('mediaprobe -show_entries stream=codec_name,sample_rate -of csv clip.mp4');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'stream,h264\nstream,aac,44100\n');
  });

  it('selects streams and prints bare values', async () => {
    const r = await sh(
      'mediaprobe -show_entries stream=channels -select_streams a:0 -of default=nw=1:nk=1 clip.mp4'
    );
    assert.equal(r.stdout, '1\n');
  });

  it('prints a human summary without -show_* or -of', async () => {
    const r = await sh('mediaprobe tone.wav');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Input #0, wav, from 'tone\.wav':\n/);
    assert.match(r.stdout, /Stream #0:0: Audio: pcm_s16le, 8000 Hz, mono\n$/);
  });

  it('reads a pipe and a redirected file on stdin', async () => {
    const piped = await sh(
      'cat clip.webm | mediaprobe -show_entries format=format_name -of csv=p=0 -'
    );
    assert.equal(piped.stdout, '"matroska,webm"\n');
    const redirected = await sh('mediaprobe -show_entries format=size -of csv=p=0 - < tone.wav');
    assert.equal(redirected.stdout, '8078\n');
  });

  it('fails on a missing file, on data that is not media, and on an unknown option', async () => {
    assert.deepEqual(await sh('mediaprobe nope.mp4'), {
      status: 1,
      stdout: '',
      stderr: 'nope.mp4: No such file or directory\n',
    });
    const junk = await sh('echo hi > junk.mp4; mediaprobe junk.mp4');
    assert.equal(junk.status, 1);
    assert.equal(junk.stderr, 'junk.mp4: Invalid data found when processing input\n');
    assert.equal((await sh('mediaprobe -v quiet junk.mp4')).stderr, '');
    const option = await sh('mediaprobe -show_frames clip.mp4');
    assert.equal(option.stderr, "mediaprobe: unsupported option '-show_frames'\n");
  });
});

describe('media on the Node kernel', () => {
  it('says what it is', async () => {
    const r = await sh('media -version');
    assert.equal(r.status, 0);
    assert.match(
      r.stdout,
      new RegExp(
        `^media \\S+ \\(@ai-ecoverse/slicc-media\\), mediabunny ${mediabunny.replaceAll('.', '\\.')}\n`
      )
    );
    assert.match(r.stdout, /This is not FFmpeg/);
  });

  it('lists only PCM encoders without WebCodecs', async () => {
    const r = await sh('media -encoders');
    assert.doesNotMatch(r.stdout, / V /);
    assert.match(r.stdout, / A pcm_s16le +pcm-s16\n/);
  });

  it('stream-copies webm into mkv and mp4 into mpegts', async () => {
    const mkv = await sh(
      'media -nostats -y -i clip.webm -c copy out.mkv && mediaprobe -show_entries stream=codec_name:format=format_name -of csv=p=0 out.mkv'
    );
    assert.equal(mkv.status, 0, mkv.stderr);
    assert.equal(mkv.stdout, 'vp9\nopus\n"matroska,webm"\n');
    const ts = await sh(
      'media -nostats -y -i clip.mp4 -c copy out.ts && mediaprobe -show_entries stream=codec_name -of csv=p=0 out.ts'
    );
    assert.equal(ts.stdout, 'h264\naac\n');
  });

  it('trims a stream copy with -t', async () => {
    const r = await sh(
      'media -nostats -y -i clip.webm -c copy -t 0.5 short.webm && mediaprobe -show_entries format=duration -of csv=p=0 short.webm'
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Number(r.stdout) < 0.6, r.stdout);
  });

  it('resamples PCM without WebCodecs', async () => {
    const r = await sh(
      'media -nostats -y -i tone.wav -ar 16000 -c:a pcm_s16le out.wav && mediaprobe -show_entries stream=codec_name,sample_rate,duration -of csv=p=0 out.wav'
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'pcm_s16le,16000,0.500000\n');
  });

  it('writes append-only containers to a pipe, and fragmented mp4', async () => {
    for (const [cmd, codecs] of [
      ['media -nostats -i clip.mp4 -c copy -f matroska -', 'h264\naac\n'],
      ['media -nostats -i clip.webm -c copy -f webm pipe:1', 'vp9\nopus\n'],
      ['media -nostats -i clip.mp4 -c copy -f mpegts -', 'h264\naac\n'],
      ['media -nostats -i clip.webm -c copy -f mp4 -', 'vp9\nopus\n'],
      ['media -nostats -i clip.mp4 -vn -c copy -f adts -', 'aac\n'],
      ['media -nostats -i tone.ogg -c copy -f ogg -', 'opus\n'],
    ]) {
      const r = await sh(`${cmd} | mediaprobe -show_entries stream=codec_name -of csv=p=0 -`);
      assert.equal(r.stdout, codecs, `${cmd}: ${r.stderr}`);
    }
  });

  it('writes stdout redirected to a file in place', async () => {
    const r = await sh(
      'media -nostats -i clip.mp4 -an -c:v copy -f mp4 - > piped.mp4 && mediaprobe -show_entries stream=codec_name -of csv=p=0 piped.mp4'
    );
    assert.equal(r.stdout, 'h264\n');
  });

  it('prints progress on stderr unless -nostats', async () => {
    const r = await sh('media -y -i tone.wav -c:a pcm_f32le f32.wav');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^time=00:00:00\.00 progress=0%\n/);
    assert.match(r.stderr, /time=00:00:00\.50 progress=100%\n$/);
  });

  it('refuses to overwrite without -y', async () => {
    await sh('echo old > exists.wav');
    const r = await sh('media -i tone.wav exists.wav');
    assert.deepEqual(r, {
      status: 1,
      stdout: '',
      stderr: "File 'exists.wav' already exists. Exiting.\n",
    });
    assert.equal((await sh('cat exists.wav')).stdout, 'old\n');
    assert.equal((await sh('media -n -i tone.wav exists.wav')).status, 1);
  });

  it('names the stream and the codec it cannot decode, and why', async () => {
    const r = await sh('media -nostats -y -i clip.mp4 -c:v libvpx-vp9 x.webm');
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      `media: video stream #0:0: no decoder for 'h264' (${NO_WEBCODECS})\nmedia: audio stream #0:1: no decoder for 'aac' (${NO_WEBCODECS})\n`
    );
  });

  it('refuses stream copies the container cannot hold', async () => {
    const r = await sh('media -nostats -y -i clip.mp4 -c copy out.webm');
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      "media: video stream #0:0: 'h264' cannot be stream-copied into webm here; re-encode it with -c:v\nmedia: audio stream #0:1: 'aac' cannot be stream-copied into webm here; re-encode it with -c:a\n"
    );
  });

  it('refuses options it cannot honour, by name', async () => {
    for (const [args, message] of [
      [
        '-i clip.mp4 -vf drawtext=text=x x.mp4',
        "video filter 'drawtext' has no WebCodecs equivalent",
      ],
      [
        '-i clip.mp4 -filter_complex overlay x.mp4',
        '-filter_complex is not supported: there are no filter graphs here',
      ],
      ['-i clip.mp4 -i tone.wav x.mp4', 'more than one input is not supported yet'],
      ['-f lavfi -i testsrc x.mp4', '-f lavfi test sources are not supported yet'],
      [
        '-i clip.mp4 -c:v libtheora x.ogg',
        "unknown or unsupported video encoder 'libtheora' (see -encoders)",
      ],
      [
        '-i clip.webm -c copy -f wav -',
        "wav can't be written to a pipe; write a file, or use -f mp4, mov, webm, mkv, mpegts, ogg, adts, mp3",
      ],
      ['-i clip.mp4 x.xyz', "unable to choose an output format for 'x.xyz'; use -f (see -formats)"],
      ['-i clip.mp4', 'at least one output file must be specified'],
    ]) {
      const r = await sh(`media ${args}`);
      assert.equal(r.status, 1, args);
      assert.equal(r.stderr, `media: ${message}\n`, args);
    }
  });

  it('reports a missing input and an input that is not media', async () => {
    assert.equal(
      (await sh('media -y -i nope.mp4 x.mkv')).stderr,
      'nope.mp4: No such file or directory\n'
    );
    assert.equal(
      (await sh('echo hi > junk.mp4; media -y -i junk.mp4 x.wav')).stderr,
      'media: Invalid data found when processing input\n'
    );
  });
});
