import {
  type AudioCodec,
  type Conversion,
  canDecodeAudio,
  canDecodeVideo,
  canEncodeAudio,
  canEncodeVideo,
  type VideoCodec,
} from 'mediabunny';
import {
  type Capture,
  captureMessage,
  DEVICE_LIST,
  type Header,
  type LiveCapture,
  live,
  parseCapture,
  quitOnQ,
  readAll,
  request,
} from '../capture.ts';
import { type Context, message, UsageError } from '../context.ts';
import { type OpenedSource, openSource, openTarget, STDIN_NAMES, STDOUT_NAMES } from '../io.ts';
import { type Invocation, parseArgs } from './args.ts';
import { AUDIO_CODECS, CONTAINERS, makePlan, type Plan } from './plan.ts';
import { ConvertError, convert } from './run.ts';

declare const MEDIA_VERSION: string;
declare const MEDIABUNNY_VERSION: string;

const NAME = 'media';

export const HELP = `usage: ${NAME} [options] -i INPUT [options] OUTPUT

Converts one media file to another with ffmpeg's command-line syntax, on the
browser's WebCodecs and mediabunny. It is not FFmpeg and contains no FFmpeg
code; codecs come from the browser, so what can be encoded depends on it
(see -encoders). Options that can't be honoured are refused by name, never
ignored.

  -i FILE              the input; '-' or pipe:0 reads stdin
  OUTPUT               the output file; '-' or pipe:1 writes stdout (with -f)
  -y, -n               overwrite the output, or never overwrite it
  -f FMT               the container (see -formats); else from the extension
  -c copy              copy every stream without re-encoding
  -c:v, -c:a CODEC     libx264, libx265, libvpx, libvpx-vp9, libaom-av1, aac,
                       libopus, libmp3lame, libvorbis, flac, pcm_s16le, ...
  -b:v, -b:a RATE      bitrates, such as 1M or 128k
  -crf N, -q:a N       quality, mapped to five presets (approximate)
  -vn, -an             drop the video or the audio
  -ss, -t, -to TIME    trim, as seconds or [HH:]MM:SS[.ms]
  -vf FILTERS          scale=W:H, crop=w:h:x:y, transpose=1|2, fps=N, format=yuv420p
  -af aresample=RATE   resample the audio
  -s WxH, -r FPS, -g N, -ac N, -ar RATE, -metadata key=value, -movflags faststart
  -nostats, -v LEVEL   no progress, or quiet/error to print errors only

  -f avfoundation -i "Capture screen 0"
                       record the screen through seven's page, until -t, q or
                       ^C (also -f x11grab, -f gdigrab -i desktop); with
                       -frames:v 1 and a .png, .jpg or .webp, take a still;
                       -list_devices true -i "" lists the devices

  -version, -encoders, -decoders, -formats, -h
`;

const VIDEO_ENCODER_NAMES: [string, VideoCodec][] = [
  ['libx264', 'avc'],
  ['libx265', 'hevc'],
  ['libvpx', 'vp8'],
  ['libvpx-vp9', 'vp9'],
  ['libaom-av1', 'av1'],
];

const AUDIO_ENCODER_NAMES = Object.entries(AUDIO_CODECS).flatMap(([name, codec]) =>
  codec === 'copy' || ['opus', 'mp3', 'vorbis'].includes(name)
    ? []
    : [[name, codec] as [string, AudioCodec]]
);

async function codecList(kind: 'encoders' | 'decoders'): Promise<string> {
  const lines: string[] = [];
  for (const [name, codec] of VIDEO_ENCODER_NAMES) {
    const ok = kind === 'encoders' ? await canEncodeVideo(codec) : await canDecodeVideo(codec);
    if (ok) lines.push(` V ${name.padEnd(12)} ${codec}`);
  }
  for (const [name, codec] of AUDIO_ENCODER_NAMES) {
    const ok = kind === 'encoders' ? await canEncodeAudio(codec) : await canDecodeAudio(codec);
    if (ok) lines.push(` A ${name.padEnd(12)} ${codec}`);
  }
  const header = `${kind[0].toUpperCase()}${kind.slice(1)} available in this runtime:\n`;
  return `${header}${lines.join('\n')}\n`;
}

function formatList(): string {
  const byContainer = new Map<string, string[]>();
  for (const [name, container] of Object.entries(CONTAINERS)) {
    byContainer.set(container, [...(byContainer.get(container) ?? []), name]);
  }
  const lines = [...byContainer].map(([c, names]) => ` DE ${c.padEnd(7)} ${names.join(', ')}`);
  return `File formats (D = read, E = write):\n${lines.join('\n')}\n`;
}

function version(): string {
  return `${NAME} ${MEDIA_VERSION} (@ai-ecoverse/slicc-media), mediabunny ${MEDIABUNNY_VERSION}
An ffmpeg-compatible media command line for SLICC on the browser's WebCodecs.
This is not FFmpeg, and it contains no FFmpeg code and no codecs.
`;
}

async function info(ctx: Context, args: string[]): Promise<number | null> {
  for (const arg of args) {
    if (arg === '-h' || arg === '-help' || arg === '--help')
      return ctx.write(1, HELP).then(() => 0);
    if (arg === '-version' || arg === '--version') return ctx.write(1, version()).then(() => 0);
    if (arg === '-encoders' || arg === '-decoders') {
      return ctx
        .write(1, await codecList(arg === '-encoders' ? 'encoders' : 'decoders'))
        .then(() => 0);
    }
    if (arg === '-formats') return ctx.write(1, formatList()).then(() => 0);
  }
  return null;
}

async function readLine(ctx: Context): Promise<string> {
  let line = '';
  for (;;) {
    const chunk = await ctx.read(0, 1);
    if (chunk.length === 0) return line;
    const ch = String.fromCharCode(chunk[0]);
    if (ch === '\n') return line;
    line += ch;
  }
}

async function mayOverwrite(ctx: Context, inv: Invocation, out: string): Promise<boolean> {
  if (STDOUT_NAMES.has(out) || inv.overwrite === 'yes') return true;
  if (!(await ctx.fs.exists(ctx.resolve(out)))) return true;
  const stdinIsInput = inv.inputs.some((i) => STDIN_NAMES.has(i.path));
  if (inv.overwrite === 'ask' && !stdinIsInput && (await ctx.fdStatus(0)).tty) {
    await ctx.write(2, `File '${out}' already exists. Overwrite? [y/N] `);
    if (/^y/i.test(await readLine(ctx))) return true;
    await ctx.write(2, 'Not overwriting - exiting\n');
    return false;
  }
  await ctx.write(2, `File '${out}' already exists. Exiting.\n`);
  return false;
}

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2).padStart(5, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`;
}

function progressReporter(ctx: Context, tty: boolean) {
  let last = -1;
  const report = (fraction: number, seconds: number): void => {
    const step = Math.floor(fraction * (tty ? 100 : 10));
    if (step === last) return;
    last = step;
    const line = `time=${clock(seconds)} progress=${Math.floor(fraction * 100)}%`;
    void ctx.write(2, tty ? `\r${line}` : `${line}\n`);
  };
  const end = async (): Promise<void> => {
    if (tty && last >= 0) await ctx.write(2, '\n');
  };
  return { report, end };
}

type Screen = Extract<Capture, { list: false }>;

const exiting = (signal: number): string => `Exiting normally, received signal ${signal}.\n`;

async function runStill(ctx: Context, inv: Invocation, header: Header): Promise<number> {
  const out = inv.outputPath as string;
  if (!(await mayOverwrite(ctx, inv, out))) return 1;
  let signal = 0;
  let file: Awaited<ReturnType<typeof request>> | undefined;
  const stop = (n: number) => (): void => {
    signal = n;
    void file?.close().catch(() => {});
  };
  ctx.signals?.on('SIGINT', stop(2));
  ctx.signals?.on('SIGTERM', stop(15));
  ctx.signals?.on('SIGHUP', stop(1));
  let bytes: Uint8Array;
  try {
    file = await request(ctx, header);
    if (signal) await file.close().catch(() => {});
    bytes = await readAll(file);
  } catch (err) {
    if (signal) return ctx.write(2, exiting(signal)).then(() => 255);
    await ctx.write(2, `${NAME}: ${captureMessage(err)}\n`);
    return 1;
  } finally {
    await file?.close().catch(() => {});
  }
  if (signal) return ctx.write(2, exiting(signal)).then(() => 255);
  if (bytes.length === 0) return ctx.write(2, `${NAME}: the page sent no image\n`).then(() => 1);
  try {
    const target = await ctx.open(ctx.resolve(out), { write: true, create: true, truncate: true });
    await target.write(0, bytes);
    await target.close();
  } catch (err) {
    await ctx.write(2, `${NAME}: ${out}: ${message(err)}\n`);
    return 1;
  }
  return 0;
}

function captureInvocation(inv: Invocation, screen: Screen | null): Invocation {
  if (!screen) return inv;
  return { ...inv, inputs: [{ path: inv.inputs[0].path, raw: screen.rest }] };
}

interface Job {
  inv: Invocation;
  plan?: Plan;
  screen: Screen | null;
}

async function prepare(ctx: Context, args: string[]): Promise<Job | number> {
  try {
    const inv = parseArgs(args);
    const capture = parseCapture(inv);
    if (capture?.list) return ctx.write(2, DEVICE_LIST).then(() => 0);
    if (capture?.still) return { inv, screen: capture };
    const pipe = inv.outputPath !== null && STDOUT_NAMES.has(inv.outputPath);
    const toPipe = pipe && (await ctx.fdStatus(1)).type !== 'file';
    return { inv, screen: capture, plan: makePlan(captureInvocation(inv, capture), toPipe) };
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    await ctx.write(2, `${NAME}: ${err.message}\n`);
    return 1;
  }
}

async function openInput(ctx: Context, job: Job, plan: Plan): Promise<OpenedSource | null> {
  const { inv, screen } = job;
  try {
    if (!screen) return await openSource(ctx, inv.inputs[0].path);
    const end = plan.trim?.end;
    const header: Header = end === undefined ? screen.header : { ...screen.header, duration: end };
    return live(await request(ctx, header));
  } catch (err) {
    const text = screen
      ? `${NAME}: ${captureMessage(err)}`
      : `${inv.inputs[0].path}: ${message(err)}`;
    await ctx.write(2, `${text}\n`);
    return null;
  }
}

async function failed(
  ctx: Context,
  err: unknown,
  capture: LiveCapture | undefined,
  signal: number
): Promise<number> {
  if (capture?.failure() !== undefined) {
    await ctx.write(2, `${NAME}: ${captureMessage(capture.failure())}\n`);
    return 1;
  }
  if (capture?.received() === 0) {
    if (signal) return ctx.write(2, exiting(signal)).then(() => 255);
    return ctx.write(2, `${NAME}: the page sent no video\n`).then(() => 1);
  }
  const text = err instanceof ConvertError ? err.message : message(err);
  const lines = text.split('\n').map((l) => `${NAME}: ${l}\n`);
  await ctx.write(2, lines.join(''));
  return 1;
}

async function run(ctx: Context, job: Job, plan: Plan): Promise<number> {
  const { inv, screen } = job;
  const outPath = inv.outputPath as string;
  if (!(await mayOverwrite(ctx, inv, outPath))) return 1;
  const source = await openInput(ctx, job, plan);
  if (!source) return 1;
  const capture = screen ? (source as LiveCapture) : undefined;
  let target: Awaited<ReturnType<typeof openTarget>> | undefined;
  let conversion: Conversion | undefined;
  let signal = 0;
  const stop = (n: number) => (): void => {
    signal = n;
    if (capture) capture.stop();
    else void conversion?.cancel();
  };
  ctx.signals?.on('SIGINT', stop(2));
  ctx.signals?.on('SIGTERM', stop(15));
  if (capture) ctx.signals?.on('SIGHUP', stop(1));
  const nostdin = [...inv.inputs[0].raw, ...inv.outputOpts].includes('-nostdin');
  const release = capture && !nostdin ? await quitOnQ(ctx, capture.stop) : async () => {};
  const quiet = ['quiet', 'panic', 'fatal', 'error', '-8', '0', '8', '16'].includes(inv.loglevel);
  const progress = progressReporter(ctx, (await ctx.fdStatus(2)).tty);
  try {
    target = await openTarget(ctx, outPath, () => void conversion?.cancel());
    const result = await convert({
      plan,
      source: source.source,
      target: target.target,
      onProgress: quiet || !inv.stats || capture ? undefined : progress.report,
      onConversion: (c) => {
        conversion = c;
        if (signal && !capture) void c.cancel();
      },
      canceled: () => (signal !== 0 && !capture) || target?.error() !== undefined,
    });
    await progress.end();
    if (target.error() !== undefined) {
      await ctx.write(2, `${NAME}: ${outPath}: ${message(target.error())}\n`);
      return 1;
    }
    if (result === 'canceled' || signal) {
      await ctx.write(2, exiting(signal));
      return 255;
    }
    return 0;
  } catch (err) {
    await progress.end();
    return failed(ctx, err, capture, signal);
  } finally {
    await release();
    await source.close();
    await target?.close();
  }
}

export async function runMedia(ctx: Context, args: string[]): Promise<number> {
  if (args.length === 0) {
    await ctx.write(2, `${HELP}\n${NAME}: no input given\n`);
    return 1;
  }
  const shown = await info(ctx, args);
  if (shown !== null) return shown;
  const job = await prepare(ctx, args);
  if (typeof job === 'number') return job;
  if (job.screen?.still) return runStill(ctx, job.inv, job.screen.header);
  return run(ctx, job, job.plan as Plan);
}
