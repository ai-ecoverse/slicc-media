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

describe('capture on the Node kernel', () => {
  it('lists the screen and no microphones without a page', async () => {
    assert.deepEqual(await sh('media -f avfoundation -list_devices true -i ""'), {
      status: 0,
      stdout: '',
      stderr:
        '[AVFoundation indev @ 0x0] AVFoundation video devices:\n[AVFoundation indev @ 0x0] [0] Capture screen 0\n[AVFoundation indev @ 0x0] AVFoundation audio devices:\n',
    });
  });

  it('needs the page, and writes nothing without it', async () => {
    for (const args of [
      '-f avfoundation -i "Capture screen 0" -t 1 nopage.webm',
      '-f x11grab -i :0.0 nopage.webm',
      '-f gdigrab -i desktop -frames:v 1 nopage.png',
    ]) {
      const r = await sh(`media -y ${args}; ls nopage.webm nopage.png 2>&1`);
      assert.match(
        r.stderr,
        /^media: capture needs seven's page \(no page answers capture\.screen\)\n/,
        args
      );
      assert.match(r.stdout, /cannot access 'nopage\.webm'/, args);
    }
    assert.equal((await sh('media -f avfoundation -i 0 -t 1 nopage.mp4')).status, 1);
  });

  it('needs the page for a microphone too', async () => {
    for (const args of [
      '-f avfoundation -i ":0" -t 1 nopage.wav',
      '-f avfoundation -i "none:default" nopage.wav',
      '-f pulse -i default -t 1 nopage.wav',
      '-f alsa -i "USB Mic" nopage.wav',
    ]) {
      const r = await sh(`media -y ${args}; echo st=$?; ls nopage.wav 2>&1`);
      assert.equal(
        r.stderr,
        "media: capture needs seven's page (no page answers audio.record)\n",
        args
      );
      assert.match(r.stdout, /^st=1\n.*cannot access 'nopage\.wav'/, args);
    }
  });

  it('refuses cameras, microphones and options it cannot honour, by name', async () => {
    for (const [args, message] of [
      ['-f avfoundation -i 1 x.mp4', '-f avfoundation -i "1": not supported yet'],
      [
        '-f avfoundation -i "FaceTime HD Camera" x.mp4',
        '-f avfoundation -i "FaceTime HD Camera": not supported yet',
      ],
      ['-f avfoundation -i "0:0" x.mp4', '-f avfoundation -i "0:0": not supported yet'],
      ['-f avfoundation -i "1:Mic" x.mp4', '-f avfoundation -i "1:Mic": not supported yet'],
      ['-f avfoundation -i none x.mp4', '-f avfoundation -i "none": nothing to capture'],
      [
        '-f avfoundation -i "none:none" x.wav',
        '-f avfoundation -i "none:none": nothing to capture',
      ],
      ['-f v4l2 -i /dev/video0 x.mp4', '-f v4l2 -i "/dev/video0": not supported yet'],
      ['-f dshow -i video=Cam x.mp4', '-f dshow -i "video=Cam": not supported yet'],
      ['-f pulse -list_devices true -i ""', '-list_devices is only for -f avfoundation'],
      [
        '-f avfoundation -framerate 30 -i ":0" x.wav',
        'input option -framerate is not for a microphone',
      ],
      [
        '-f alsa -video_size 640x480 -i default x.wav',
        'input option -video_size is not for a microphone',
      ],
      ['-f pulse -i default', 'at least one output file must be specified'],
      [
        '-f x11grab -i :0.0+100,200 x.mp4',
        'x11grab offsets (+100,200) are not supported; crop with -vf crop=w:h:x:y',
      ],
      [
        '-f gdigrab -i hwnd=1 x.mp4',
        "gdigrab input 'hwnd=1' is not supported; use desktop or title=…",
      ],
      [
        '-f x11grab -video_size 1280x720 -i :0 x.mp4',
        '-video_size is not supported for the screen; scale with -vf scale=W:H',
      ],
      [
        '-f x11grab -draw_mouse 0 -i :0 x.mp4',
        'input option -draw_mouse is not supported; use -capture_cursor 0 or 1',
      ],
      [
        '-f avfoundation -capture_mouse_clicks 1 -i 0 x.mp4',
        'input option -capture_mouse_clicks is not supported',
      ],
      ['-f x11grab -list_devices true -i ""', '-list_devices is only for -f avfoundation'],
      [
        '-f avfoundation -i 0 -vf scale=640:-2 shot.png',
        '-vf: not with a still; the page writes the image as it is',
      ],
      [
        '-f avfoundation -i 0 -frames:v 1 shot.mp4',
        'a still needs a .png, .jpg, .jpeg or .webp output',
      ],
      [
        '-f avfoundation -i 0 -frames:v 30 x.mp4',
        '-frames:v 30: only one frame, a still, can be captured',
      ],
      ['-f avfoundation -i 0', 'at least one output file must be specified'],
    ]) {
      const r = await sh(`media ${args}`);
      assert.equal(r.status, 1, args);
      assert.equal(r.stderr, `media: ${message}\n`, args);
    }
  });
});

describe('capture through a page hook on the Node kernel', () => {
  let page;
  const live = [];

  function liveWebm() {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/clip.webm', import.meta.url)));
    bytes.set([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0x28);
    return bytes;
  }

  before(async () => {
    page = await boot({
      requests: {
        kinds: { 'capture.screen': {} },
        handle: ({ signal }) =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(liveWebm());
              live.push(controller);
              signal.addEventListener('abort', () => controller.close(), { once: true });
            },
          }),
      },
    });
  });

  after(() => page?.close());

  async function terminal(script) {
    let output = '';
    const term = await page.kernel.openTerminal(['sh', '-c', script], {
      cwd: '/tmp',
      onData: (data) => {
        output += new TextDecoder().decode(data);
      },
    });
    const before = live.length;
    for (let i = 0; i < 400 && live.length === before; i++) {
      await new Promise((ok) => setTimeout(ok, 25));
    }
    assert.ok(live.length > before, 'the page got the request');
    await new Promise((ok) => setTimeout(ok, 500));
    return { term, output: () => output };
  }

  it('stops on q from a terminal, finalizes the file and puts the terminal back', async () => {
    const { term, output } = await terminal(
      'media -y -f avfoundation -i 0 -c copy q.mkv; echo st=$?; stty -a'
    );
    term.write('q');
    await term.exited;
    assert.match(output(), /st=0\r?\n/);
    assert.doesNotMatch(output(), /-icanon|-echo /);
    const r = await page.sh(
      'mediaprobe -v error -show_entries stream=codec_type -of csv=p=0 q.mkv'
    );
    assert.equal(r.stdout, 'video\naudio\n', r.stderr);
  });

  it('leaves the terminal alone with -nostdin, and stops on ^C', async () => {
    const { term, output } = await terminal(
      'media -nostdin -y -f avfoundation -i 0 -c copy n.mkv; echo st=$?'
    );
    term.write('q');
    await new Promise((ok) => setTimeout(ok, 500));
    assert.doesNotMatch(output(), /st=/);
    term.write('\x03');
    await term.exited;
    assert.match(output(), /Exiting normally, received signal 2\./);
    assert.match(output(), /st=255\r?\n/);
    const r = await page.sh(
      'mediaprobe -v error -show_entries stream=codec_type -of csv=p=0 n.mkv'
    );
    assert.equal(r.stdout, 'video\naudio\n', r.stderr);
  });

  it('finalizes on SIGHUP and exits 255', async () => {
    const r = await page.sh(
      'media -nostats -y -f x11grab -i :0 -c copy h.mkv & pid=$!; sleep 1; kill -HUP $pid; wait $pid; echo st=$?; mediaprobe -v error -show_entries stream=codec_type -of csv=p=0 h.mkv'
    );
    assert.equal(r.stdout, 'st=255\nvideo\naudio\n', r.stderr);
    assert.match(r.stderr, /Exiting normally, received signal 1\.\n$/);
  });
});

describe('the microphone through a page hook on the Node kernel', () => {
  let page;
  const mic = { refuse: null, fail: false, empty: false, requests: [], live: [], bytes: null };

  function recording(options, signal) {
    return new ReadableStream({
      start(controller) {
        if (mic.empty) return controller.close();
        controller.enqueue(mic.bytes);
        if (mic.fail) {
          setTimeout(() => controller.error(new Error('the microphone went away')), 300);
          return;
        }
        mic.live.push(controller);
        const end = () => {
          try {
            controller.close();
          } catch {}
        };
        if (options.seconds !== undefined) setTimeout(end, options.seconds * 1000);
        signal.addEventListener('abort', end, { once: true });
      },
    });
  }

  function brokenScreen() {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(mic.bytes.slice(0, 4000));
        setTimeout(() => controller.error(new Error('boom')), 300);
      },
    });
  }

  before(async () => {
    page = await boot({
      requests: {
        kinds: { 'audio.record': {}, 'capture.screen': {} },
        handle: async ({ kind, options, signal }) => {
          mic.requests.push({ kind, ...options });
          if (kind === 'capture.screen') return brokenScreen();
          if (options.devices) return 'default\tDefault - Built-in\nusb-1\tUSB Mic\nanon\t\n';
          if (mic.refuse) throw new DOMException(mic.refuse, 'NotAllowedError');
          return recording(options, signal);
        },
      },
    });
    const made = await page.sh(
      'media -nostats -i clip.webm -vn -c:a copy -f webm - | cat > mic.webm'
    );
    assert.equal(made.status, 0, made.stderr);
    mic.bytes = new Uint8Array(await page.kernel.readFile('/tmp/mic.webm'));
  });

  after(() => page?.close());

  const last = () => mic.requests.filter((r) => !r.devices).at(-1);
  const streams = (file) =>
    `mediaprobe -v error -show_entries stream=codec_type,codec_name -of csv=p=0 ${file}`;

  it('lists the microphones after the screen, with a name for an empty label', async () => {
    const r = await page.sh('media -f avfoundation -list_devices true -i ""');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stderr,
      [
        'AVFoundation video devices:',
        `[0] Capture screen 0`,
        'AVFoundation audio devices:',
        '[0] Default - Built-in',
        '[1] USB Mic',
        '[2] Microphone 2',
      ]
        .map((line) => `[AVFoundation indev @ 0x0] ${line}\n`)
        .join('')
    );
  });

  it('asks audio.record without the gate, for the device named by index or label', async () => {
    for (const [args, device] of [
      ['-f avfoundation -i ":1"', 'usb-1'],
      ['-f avfoundation -i "none:usb mic"', 'usb-1'],
      ['-f pulse -i "Microphone 2"', 'anon'],
      ['-f alsa -i 0', 'default'],
      ['-f pulse -i default', undefined],
    ]) {
      const r = await page.sh(`media -y ${args} -t 1 -c copy m.mkv && ${streams('m.mkv')}`);
      assert.equal(r.status, 0, `${args}: ${r.stderr}`);
      assert.equal(r.stdout, 'audio,opus\n', args);
      const header = { kind: 'audio.record', gate: false, seconds: 1 };
      assert.deepEqual(last(), device ? { ...header, device } : header, args);
    }
  });

  it('copies the Opus into webm and ogg', async () => {
    for (const out of ['m.webm', 'm.ogg']) {
      const r = await page.sh(
        `media -y -f avfoundation -i ":0" -t 1 -c:a copy ${out} && ${streams(out)}`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'audio,opus\n', out);
    }
  });

  it('refuses a device the page does not list', async () => {
    const r = await page.sh('media -y -f alsa -i 3 -c copy none.mkv; echo st=$?; ls none.mkv 2>&1');
    assert.equal(r.stderr, 'media: no such audio device: 3\n');
    assert.match(r.stdout, /^st=1\n.*cannot access 'none\.mkv'/);
  });

  it('passes the page refusal on and leaves an existing output alone', async () => {
    mic.refuse = "microphone capture is off in seven's settings";
    const r = await page.sh(
      'echo keep > kept.mkv; media -y -f avfoundation -i ":0" -c copy kept.mkv; echo st=$?; cat kept.mkv; media -y -f pulse -i default -c copy gone.mkv; ls gone.mkv 2>&1'
    );
    mic.refuse = null;
    assert.equal(r.stderr, "media: microphone capture is off in seven's settings\n".repeat(2));
    assert.match(r.stdout, /^st=1\nkeep\n.*cannot access 'gone\.mkv'/);
  });

  it('says the page sent no audio and writes nothing', async () => {
    mic.empty = true;
    const r = await page.sh(
      'media -y -f pulse -i default -c copy empty.mkv; echo st=$?; ls empty.mkv 2>&1'
    );
    mic.empty = false;
    assert.equal(r.stderr, 'media: the page sent no audio\n');
    assert.match(r.stdout, /^st=1\n.*cannot access 'empty\.mkv'/);
  });

  it('removes the output when the page fails partway', async () => {
    mic.fail = true;
    const r = await page.sh(
      'media -nostats -y -f avfoundation -i ":0" -c copy failed.mkv; echo st=$?; ls failed.mkv 2>&1'
    );
    mic.fail = false;
    assert.equal(r.stderr, 'media: the microphone went away\n');
    assert.match(r.stdout, /^st=1\n.*cannot access 'failed\.mkv'/);
  });

  it('leaves no empty file when a screen capture fails partway', async () => {
    const r = await page.sh(
      'media -nostats -y -f avfoundation -i 0 -c copy c.mkv; echo st=$?; ls c.mkv 2>&1'
    );
    assert.match(r.stderr, /boom/);
    assert.match(r.stdout, /^st=1\n.*cannot access 'c\.mkv'/);
  });

  it('finalizes on SIGINT and exits 255, and exits 0 when the page ends', async () => {
    const r = await page.sh(
      `media -nostats -y -f pulse -i default -c copy int.mkv & pid=$!; sleep 1; kill -INT $pid; wait $pid; echo st=$?; ${streams('int.mkv')}`
    );
    assert.equal(r.stdout, 'st=255\naudio,opus\n', r.stderr);
    assert.match(r.stderr, /Exiting normally, received signal 2\.\n$/);
    const before = mic.live.length;
    const ending = page.sh(
      `media -nostats -y -f pulse -i default -c copy end.mkv; echo st=$?; ${streams('end.mkv')}`
    );
    while (mic.live.length === before) await new Promise((ok) => setTimeout(ok, 25));
    await new Promise((ok) => setTimeout(ok, 500));
    mic.live.at(-1).close();
    const e = await ending;
    assert.equal(e.stdout, 'st=0\naudio,opus\n', e.stderr);
  });
});
