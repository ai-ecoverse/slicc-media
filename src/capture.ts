import { ReadableStreamSource } from 'mediabunny';
import { type Context, type KernelFile, message, UsageError } from './context.ts';
import type { Invocation } from './convert/args.ts';
import { parseTime } from './convert/plan.ts';
import type { OpenedSource } from './io.ts';

export const SCREEN = 'Capture screen 0';

const SCREEN_FORMATS = new Set(['x11grab', 'gdigrab']);
const MICROPHONE_FORMATS = new Set(['pulse', 'alsa']);
const FORMATS = new Set([
  'avfoundation',
  'v4l2',
  'dshow',
  ...SCREEN_FORMATS,
  ...MICROPHONE_FORMATS,
]);
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

const NUMBER = /^\d+$/;
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
  microphone?: true | string;
}

export interface CameraHeader {
  kind: 'capture.camera';
  type: string;
  quality?: number;
  device?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  exact?: true;
  warmup?: number;
  duration?: number;
  microphone?: true | string;
}

export interface MicrophoneHeader {
  kind: 'audio.record';
  gate: false;
  device?: string;
  seconds?: number;
}

export type Header = ScreenHeader | CameraHeader | MicrophoneHeader;

export type Video =
  | { screen: 'monitor' | 'window' }
  | { camera: string; shown: string; counted: boolean };

export interface Recording {
  list: false;
  video: Video | null;
  audio: string | null;
  still: string | null;
  cursor?: 'always' | 'never';
  size?: { width: number; height: number };
  frameRate?: number;
  warmup?: number;
  rest: string[];
}

export type Capture = { list: true } | Recording;

export interface Named {
  id: string;
  name: string;
}

export interface Devices {
  cameras: Named[];
  microphones: Named[];
}

export class CaptureError extends Error {}

export class NoPage extends CaptureError {}

function reject(reason: string): never {
  throw new UsageError(reason);
}

function form(format: string, spec: string): string {
  return `-f ${format} -i ${JSON.stringify(spec)}`;
}

const none = (part: string): boolean => part === '' || part.toLowerCase() === 'none';

const microphone = (spec: string): string =>
  none(spec) || spec.toLowerCase() === 'default' ? 'default' : spec;

const unquote = (part: string): string => part.trim().replace(/^"(.*)"$/, '$1');

interface Source {
  video: Video | null;
  audio: string | null;
}

function avfoundation(spec: string): Source {
  const colon = spec.indexOf(':');
  const video = (colon < 0 ? spec : spec.slice(0, colon)).trim();
  const audio = colon < 0 ? '' : spec.slice(colon + 1).trim();
  if (none(video) && none(audio)) reject(`${form('avfoundation', spec)}: nothing to capture`);
  return {
    video: none(video)
      ? null
      : video.toLowerCase() === SCREEN.toLowerCase()
        ? { screen: 'monitor' }
        : { camera: video, shown: video, counted: true },
    audio: none(audio) ? null : microphone(audio),
  };
}

function v4l2(spec: string): Source {
  const device = /^\/dev\/video(\d+)$/.exec(spec);
  if (!device) reject(`v4l2 input '${spec}' is not supported; use /dev/videoN`);
  return { video: { camera: device[1], shown: spec, counted: false }, audio: null };
}

function dshow(spec: string): Source {
  const at = spec.indexOf(':audio=');
  let video = '';
  let audio = '';
  if (spec.startsWith('audio=')) audio = spec.slice(6);
  else if (spec.startsWith('video=')) {
    video = at < 0 ? spec.slice(6) : spec.slice(6, at);
    audio = at < 0 ? '' : spec.slice(at + 7);
  } else reject(`dshow input '${spec}' is not supported; use video="NAME", audio="NAME" or both`);
  video = unquote(video);
  audio = unquote(audio);
  if (video === '' && audio === '') reject(`${form('dshow', spec)}: nothing to capture`);
  return {
    video: video === '' ? null : { camera: video, shown: video, counted: false },
    audio: audio === '' ? null : microphone(audio),
  };
}

function sourceOf(format: string, spec: string): Source {
  if (format === 'avfoundation') return avfoundation(spec);
  if (format === 'v4l2') return v4l2(spec);
  if (format === 'dshow') return dshow(spec);
  if (MICROPHONE_FORMATS.has(format)) return { video: null, audio: microphone(spec.trim()) };
  if (format === 'x11grab') {
    const offset = /\+(\d+),(\d+)$/.exec(spec);
    if (offset) {
      reject(
        `x11grab offsets (+${offset[1]},${offset[2]}) are not supported; crop with -vf crop=w:h:x:y`
      );
    }
    return { video: { screen: 'monitor' }, audio: null };
  }
  if (spec === 'desktop') return { video: { screen: 'monitor' }, audio: null };
  if (spec.startsWith('title=')) return { video: { screen: 'window' }, audio: null };
  return reject(`gdigrab input '${spec}' is not supported; use desktop or title=…`);
}

interface InputOptions {
  list: boolean;
  cursor?: 'always' | 'never';
  size?: { width: number; height: number };
  frameRate?: number;
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
    out.frameRate = Number(value);
  } else if (tok === '-video_size') {
    const size = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(value);
    if (!size) reject(`-video_size '${value}' is not a size; use WxH`);
    out.size = { width: Number(size[1]), height: Number(size[2]) };
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

function stillOf(inv: Invocation): string | null {
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
  return type;
}

function stillOptions(lists: string[][]): void {
  for (const list of lists) {
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
}

function warmupOf(rest: string[]): { warmup?: number; rest: string[] } {
  const at = rest.indexOf('-ss');
  if (at < 0) return { rest };
  return { warmup: parseTime(rest[at + 1]), rest: [...rest.slice(0, at), ...rest.slice(at + 2)] };
}

export function parseCapture(inv: Invocation): Capture | null {
  if (inv.inputs.length !== 1) return null;
  const [input] = inv.inputs;
  const format = input.format ?? '';
  if (!FORMATS.has(format)) return null;
  const options = inputOptions(input.raw, format);
  if (options.list) return { list: true };
  const { video, audio } = sourceOf(format, input.path);
  if (video === null && options.video.length > 0)
    reject(`input option ${options.video[0]} is not for a microphone`);
  if (inv.outputPath === null) reject('at least one output file must be specified');
  const recording: Recording = { list: false, video, audio, still: null, rest: options.rest };
  if (options.cursor) recording.cursor = options.cursor;
  if (options.size) recording.size = options.size;
  if (options.frameRate !== undefined) recording.frameRate = options.frameRate;
  if (video === null) return recording;
  recording.still = stillOf(inv);
  if (recording.still !== null) {
    if (audio !== null) reject(`${form(format, input.path)}: a still has no audio`);
    const { warmup, rest } = warmupOf(options.rest);
    stillOptions([inv.outputOpts, rest]);
    if (warmup !== undefined) recording.warmup = warmup;
    recording.rest = rest;
  }
  if ('screen' in video) screenChecks(recording);
  else if (!video.counted || !NUMBER.test(video.camera)) cameraChecks(recording);
  return recording;
}

function screenChecks(recording: Recording): void {
  if (recording.size)
    reject('-video_size is not supported for the screen; scale with -vf scale=W:H');
  if (recording.warmup !== undefined)
    reject('-ss: not with a still; the page writes the image as it is');
}

function cameraChecks(recording: Recording): void {
  if (recording.cursor) reject('input option -capture_cursor is not for a camera');
}

export function kindOf(recording: Recording): Header['kind'] {
  if (recording.video === null) return 'audio.record';
  return 'screen' in recording.video ? 'capture.screen' : 'capture.camera';
}

function quality(type: string): { quality?: number } {
  return type === 'image/jpeg' || type === 'image/webp' ? { quality: 0.92 } : {};
}

type Picked = { screen: 'monitor' | 'window' } | { device?: string };

function pick(video: Video, found: Devices | null): Picked {
  if ('screen' in video) return video;
  const spec = video.camera;
  if (spec.toLowerCase() === 'default') return {};
  const cameras = found?.cameras ?? [];
  const numbered = NUMBER.test(spec);
  const hit = numbered
    ? cameras[Number(spec)]
    : cameras.find((c) => c.name.toLowerCase() === spec.toLowerCase());
  if (hit) return hit.id ? { device: hit.id } : {};
  if (video.counted && numbered && Number(spec) === cameras.length) return { screen: 'monitor' };
  if (!found) throw new NoPage("capture needs seven's page (no page answers capture.camera)");
  throw new CaptureError(`no such camera: ${video.shown}`);
}

function needs(recording: Recording): { cameras: boolean; microphones: boolean } {
  const video = recording.video;
  return {
    cameras: video !== null && 'camera' in video && video.camera.toLowerCase() !== 'default',
    microphones: recording.audio !== null && recording.audio !== 'default',
  };
}

export async function headerOf(
  ctx: Context,
  recording: Recording,
  end: number | undefined
): Promise<Header> {
  const need = needs(recording);
  const found = need.cameras || need.microphones ? await catalog(ctx) : null;
  const picked = recording.video === null ? null : pick(recording.video, found);
  const mic = need.microphones
    ? microphoneOf(found?.microphones ?? (await microphones(ctx)), recording.audio as string)
    : undefined;
  if (picked === null) {
    const header: MicrophoneHeader = { kind: 'audio.record', gate: false };
    if (mic !== undefined) header.device = mic;
    if (end !== undefined) header.seconds = end;
    return header;
  }
  const extra = {
    ...(end === undefined ? {} : { duration: end }),
    ...(recording.audio === null ? {} : { microphone: mic ?? (true as const) }),
  };
  const type = recording.still ?? 'video/webm';
  if ('screen' in picked) {
    screenChecks(recording);
    const header: ScreenHeader = {
      kind: 'capture.screen',
      type,
      ...quality(type),
      surface: picked.screen,
    };
    if (recording.cursor) header.cursor = recording.cursor;
    return { ...header, ...extra };
  }
  cameraChecks(recording);
  const header: CameraHeader = { kind: 'capture.camera', type, ...quality(type) };
  if (picked.device !== undefined) header.device = picked.device;
  if (recording.size) Object.assign(header, recording.size);
  if (recording.frameRate !== undefined) header.frameRate = recording.frameRate;
  if (recording.size && recording.frameRate !== undefined) header.exact = true;
  if (recording.warmup !== undefined) header.warmup = recording.warmup;
  return { ...header, ...extra };
}

export function codeOf(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

export function captureMessage(err: unknown, kind: string): string {
  if (err instanceof CaptureError) return err.message;
  const detail = (err as { detail?: unknown } | null)?.detail;
  if (kind !== 'capture.screen' && typeof detail === 'string') return detail;
  if (codeOf(err) === 'EACCES' && kind !== 'capture.camera')
    return 'user cancelled, permission denied, or the surface is protected';
  return message(err);
}

export function deviceList(found: Devices): string {
  const line = (text: string): string => `[AVFoundation indev @ 0x0] ${text}\n`;
  return [
    line('AVFoundation video devices:'),
    ...found.cameras.map((c, i) => line(`[${i}] ${c.name}`)),
    line(`[${found.cameras.length}] ${SCREEN}`),
    line('AVFoundation audio devices:'),
    ...found.microphones.map((m, i) => line(`[${i}] ${m.name}`)),
  ].join('');
}

export function microphoneOf(microphones: Named[], spec: string): string | undefined {
  const wanted = spec.toLowerCase();
  const found = NUMBER.test(spec)
    ? microphones[Number(spec)]
    : microphones.find((m) => m.name.toLowerCase() === wanted);
  if (!found) throw new CaptureError(`no such audio device: ${spec}`);
  return found.id || undefined;
}

async function ask(ctx: Context, header: Asked): Promise<string> {
  const file = await request(ctx, header);
  try {
    return new TextDecoder().decode(await readAll(file));
  } finally {
    await file.close().catch(ignore);
  }
}

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');

export async function microphones(ctx: Context): Promise<Named[]> {
  const text = await ask(ctx, { kind: 'audio.record', devices: true });
  return lines(text).map((line, i) => {
    const tab = line.indexOf('\t');
    const id = tab < 0 ? line : line.slice(0, tab);
    const label = tab < 0 ? '' : line.slice(tab + 1).trim();
    return { id, name: label || `Microphone ${i}` };
  });
}

export const unanswered = (err: unknown): boolean =>
  err instanceof NoPage || codeOf(err) === 'ENOTSUP';

export async function catalog(ctx: Context): Promise<Devices | null> {
  let text: string;
  try {
    text = await ask(ctx, { kind: 'capture.devices' });
  } catch (err) {
    if (unanswered(err)) return null;
    throw err;
  }
  const found: Devices = { cameras: [], microphones: [] };
  for (const line of lines(text)) {
    const [what, id = '', ...label] = line.split('\t');
    const list = what === 'video' ? found.cameras : what === 'audio' ? found.microphones : null;
    if (!list) continue;
    const name = label.join('\t').trim();
    list.push({ id, name: name || `${what === 'video' ? 'Camera' : 'Microphone'} ${list.length}` });
  }
  return found;
}

type Asked = Header | { kind: 'audio.record'; devices: true } | { kind: 'capture.devices' };

export async function request(ctx: Context, header: Asked): Promise<KernelFile> {
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
