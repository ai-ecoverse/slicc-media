import { ReadableStreamSource } from 'mediabunny';
import { type Context, type KernelFile, message, UsageError } from './context.ts';
import type { Invocation } from './convert/args.ts';
import type { OpenedSource } from './io.ts';

export const SCREEN = 'Capture screen 0';

export const DEVICE_LIST = `[AVFoundation indev @ 0x0] AVFoundation video devices:
[AVFoundation indev @ 0x0] [0] ${SCREEN}
[AVFoundation indev @ 0x0] AVFoundation audio devices:
`;

const SCREEN_FORMATS = new Set(['avfoundation', 'x11grab', 'gdigrab']);
const MICROPHONE_FORMATS = new Set(['pulse', 'alsa']);
const LATER_FORMATS = new Set(['v4l2', 'dshow']);
const VIDEO_INPUT_OPTIONS = new Set(['-capture_cursor', '-framerate', '-video_size']);
const TRIMS = new Set(['-ss', '-t', '-to']);
const VALUE_OPTIONS = new Set([
  ...TRIMS,
  '-i',
  '-f',
  '-list_devices',
  '-capture_cursor',
  '-framerate',
  '-video_size',
  '-draw_mouse',
  '-pixel_format',
  '-probesize',
  '-thread_queue_size',
  '-rtbufsize',
]);
const TOGGLES = new Set(['-hide_banner', '-nostdin', '-sn', '-dn', '-copyts']);
const STILL_FRAMES = new Set(['-frames:v', '-vframes', '-update']);

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const READ_SIZE = 1 << 20;
const ICANON = 0o2;
const ECHO = 0o10;
const ignore = (): void => {};

export interface ScreenHeader {
  kind: 'capture.screen';
  type: string;
  quality?: number;
  cursor?: 'always' | 'never';
  surface: 'monitor' | 'window';
  duration?: number;
}

export interface MicrophoneHeader {
  kind: 'audio.record';
  gate: false;
  device?: string;
  seconds?: number;
}

export type Header = ScreenHeader | MicrophoneHeader;

export type Capture =
  | { list: true }
  | { list: false; header: Header; still: boolean; rest: string[]; microphone?: string };

export interface Microphone {
  id: string;
  name: string;
}

type Device =
  | { what: 'screen'; surface: 'monitor' | 'window' }
  | { what: 'microphone'; spec?: string };

export class CaptureError extends Error {}

export class NoPage extends CaptureError {}

function reject(reason: string): never {
  throw new UsageError(reason);
}

function form(format: string, spec: string): string {
  return `-f ${format} -i ${JSON.stringify(spec)}`;
}

const none = (part: string): boolean => part === '' || part.toLowerCase() === 'none';

function microphone(spec: string): Device {
  return none(spec) || spec.toLowerCase() === 'default'
    ? { what: 'microphone' }
    : { what: 'microphone', spec };
}

function avfoundation(spec: string): Device {
  const colon = spec.indexOf(':');
  const video = (colon < 0 ? spec : spec.slice(0, colon)).trim();
  const audio = colon < 0 ? '' : spec.slice(colon + 1).trim();
  if (!none(audio)) {
    if (!none(video)) reject(`${form('avfoundation', spec)}: not supported yet`);
    return microphone(audio);
  }
  if (none(video)) reject(`${form('avfoundation', spec)}: nothing to capture`);
  if (video === '0' || video.toLowerCase() === SCREEN.toLowerCase())
    return { what: 'screen', surface: 'monitor' };
  return reject(`${form('avfoundation', spec)}: not supported yet`);
}

function deviceOf(format: string, spec: string): Device {
  if (format === 'avfoundation') return avfoundation(spec);
  if (MICROPHONE_FORMATS.has(format)) return microphone(spec.trim());
  if (format === 'x11grab') {
    const offset = /\+(\d+),(\d+)$/.exec(spec);
    if (offset) {
      reject(
        `x11grab offsets (+${offset[1]},${offset[2]}) are not supported; crop with -vf crop=w:h:x:y`
      );
    }
    return { what: 'screen', surface: 'monitor' };
  }
  if (spec === 'desktop') return { what: 'screen', surface: 'monitor' };
  if (spec.startsWith('title=')) return { what: 'screen', surface: 'window' };
  return reject(`gdigrab input '${spec}' is not supported; use desktop or title=…`);
}

interface InputOptions {
  list: boolean;
  cursor?: 'always' | 'never';
  video: string[];
  rest: string[];
}

function inputOption(out: InputOptions, tok: string, value: string, format: string): void {
  if (VIDEO_INPUT_OPTIONS.has(tok)) out.video.push(tok);
  if (tok === '-list_devices') {
    if (format !== 'avfoundation') reject('-list_devices is only for -f avfoundation');
    out.list = value === 'true' || value === '1';
  } else if (tok === '-capture_cursor') {
    if (value !== '0' && value !== '1') reject(`-capture_cursor ${value}: use 0 or 1`);
    out.cursor = value === '1' ? 'always' : 'never';
  } else if (tok === '-framerate') {
    if (!(Number(value) > 0)) reject(`-framerate '${value}' is not a frame rate`);
  } else if (tok === '-draw_mouse') {
    reject('input option -draw_mouse is not supported; use -capture_cursor 0 or 1');
  } else if (TRIMS.has(tok)) out.rest.push(tok, value);
}

function inputOptions(raw: string[], format: string): InputOptions {
  const out: InputOptions = { list: false, video: [], rest: [] };
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (TOGGLES.has(tok)) {
      out.rest.push(tok);
      continue;
    }
    if (!VALUE_OPTIONS.has(tok)) reject(`input option ${tok} is not supported`);
    inputOption(out, tok, raw[i + 1], format);
    i += 1;
  }
  return out;
}

function stillOf(inv: Invocation, rest: string[]): string | null {
  const opts = inv.outputOpts;
  const asked = opts.some((tok, i) => STILL_FRAMES.has(tok) && opts[i + 1] === '1');
  const ext = /\.([A-Za-z0-9]+)$/.exec(inv.outputPath as string)?.[1].toLowerCase();
  const type = ext === undefined ? undefined : IMAGE_TYPES[ext];
  if (!asked && type === undefined) {
    for (let i = 0; i < opts.length; i++) {
      if (STILL_FRAMES.has(opts[i]))
        reject(`${opts[i]} ${opts[i + 1]}: only one frame, a still, can be captured`);
    }
    return null;
  }
  if (type === undefined) return reject('a still needs a .png, .jpg, .jpeg or .webp output');
  for (const list of [opts, rest]) {
    for (let i = 0; i < list.length; i++) {
      const tok = list[i];
      if (TOGGLES.has(tok)) continue;
      const value = list[i + 1];
      i += 1;
      if (STILL_FRAMES.has(tok) && value === '1') continue;
      if (tok === '-f' && value === 'image2') continue;
      reject(`${tok}: not with a still; the page writes the image as it is`);
    }
  }
  return type;
}

export function parseCapture(inv: Invocation): Capture | null {
  if (inv.inputs.length !== 1) return null;
  const [input] = inv.inputs;
  const format = input.format ?? '';
  if (LATER_FORMATS.has(format)) reject(`${form(format, input.path)}: not supported yet`);
  if (!SCREEN_FORMATS.has(format) && !MICROPHONE_FORMATS.has(format)) return null;
  const options = inputOptions(input.raw, format);
  if (options.list) return { list: true };
  const device = deviceOf(format, input.path);
  if (device.what === 'microphone') {
    if (options.video.length > 0)
      reject(`input option ${options.video[0]} is not for a microphone`);
    if (inv.outputPath === null) reject('at least one output file must be specified');
    const header: Header = { kind: 'audio.record', gate: false };
    return { list: false, header, still: false, rest: options.rest, microphone: device.spec };
  }
  if (options.video.includes('-video_size'))
    reject('-video_size is not supported for the screen; scale with -vf scale=W:H');
  if (inv.outputPath === null) reject('at least one output file must be specified');
  const type = stillOf(inv, options.rest);
  const header: Header = {
    kind: 'capture.screen',
    type: type ?? 'video/webm',
    surface: device.surface,
  };
  if (type === 'image/jpeg' || type === 'image/webp') header.quality = 0.92;
  if (options.cursor) header.cursor = options.cursor;
  return { list: false, header, still: type !== null, rest: options.rest };
}

export function lasting(header: Header, end: number | undefined): Header {
  if (end === undefined) return header;
  if (header.kind === 'audio.record') return { ...header, seconds: end };
  return { ...header, duration: end };
}

export function codeOf(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

export function captureMessage(err: unknown, kind: Header['kind']): string {
  if (err instanceof CaptureError) return err.message;
  const detail = (err as { detail?: unknown } | null)?.detail;
  if (kind === 'audio.record' && typeof detail === 'string') return detail;
  if (codeOf(err) === 'EACCES')
    return 'user cancelled, permission denied, or the surface is protected';
  return message(err);
}

export function deviceList(microphones: Microphone[]): string {
  const lines = microphones.map((m, i) => `[AVFoundation indev @ 0x0] [${i}] ${m.name}\n`);
  return DEVICE_LIST + lines.join('');
}

export function microphoneOf(microphones: Microphone[], spec: string): string | undefined {
  const wanted = spec.toLowerCase();
  const found = /^\d+$/.test(spec)
    ? microphones[Number(spec)]
    : microphones.find((m) => m.name.toLowerCase() === wanted);
  if (!found) throw new CaptureError(`no such audio device: ${spec}`);
  return found.id || undefined;
}

export async function microphones(ctx: Context): Promise<Microphone[]> {
  const file = await request(ctx, { kind: 'audio.record', devices: true });
  let text: string;
  try {
    text = new TextDecoder().decode(await readAll(file));
  } finally {
    await file.close().catch(ignore);
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, i) => {
      const tab = line.indexOf('\t');
      const id = tab < 0 ? line : line.slice(0, tab);
      const label = tab < 0 ? '' : line.slice(tab + 1).trim();
      return { id, name: label || `Microphone ${i}` };
    });
}

export async function request(
  ctx: Context,
  header: Header | { kind: 'audio.record'; devices: true }
): Promise<KernelFile> {
  const file = await ctx.open('/dev/embedder', { read: true, write: true });
  try {
    await file.write(0, new TextEncoder().encode(`${JSON.stringify(header)}\n`));
  } catch (err) {
    await file.close().catch(ignore);
    if (codeOf(err) === 'ENOTSUP') {
      throw new NoPage(`capture needs seven's page (no page answers ${header.kind})`);
    }
    throw err;
  }
  return file;
}

export async function readAll(file: KernelFile): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const bytes = await file.read(0, READ_SIZE);
    if (bytes.length === 0) break;
    parts.push(bytes);
    size += bytes.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface LiveCapture extends OpenedSource {
  stop(): void;
  failure(): unknown;
  received(): number;
}

export function live(file: KernelFile): LiveCapture {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ended = false;
  let closed = false;
  let failure: unknown;
  let received = 0;
  const end = (): void => {
    if (ended) return;
    ended = true;
    controller?.close();
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await file.close().catch(ignore);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (c) => {
        controller = c;
      },
      pull: async (c) => {
        let bytes: Uint8Array;
        try {
          bytes = await file.read(0, READ_SIZE);
        } catch (err) {
          if (ended) return;
          if (codeOf(err) === 'EINTR') return end();
          failure = err;
          ended = true;
          c.error(err);
          return;
        }
        if (ended) return;
        if (bytes.length === 0) return end();
        received += bytes.length;
        c.enqueue(bytes);
      },
    },
    { highWaterMark: 0 }
  );
  return {
    source: new ReadableStreamSource(stream, {
      maxCacheSize: 256 * 1024 * 1024,
      handleUnhandledError: ignore,
    }),
    size: null,
    close,
    stop: () => {
      end();
      void close();
    },
    failure: () => failure,
    received: () => received,
  };
}

export async function quitOnQ(ctx: Context, quit: () => void): Promise<() => Promise<void>> {
  const tty = ctx.tty;
  if (!tty || !(await ctx.fdStatus(0)).tty) return async () => {};
  const saved = await tty.getAttr(0);
  await tty.setAttr(0, { ...saved, c_lflag: saved.c_lflag & ~(ICANON | ECHO) });
  let done = false;
  void (async () => {
    while (!done) {
      const key = await ctx.read(0, 1).catch(() => new Uint8Array(0));
      if (done || key.length === 0) return;
      if (key[0] === 0x71) {
        quit();
        return;
      }
    }
  })();
  return async () => {
    done = true;
    await tty.setAttr(0, saved).catch(ignore);
  };
}
