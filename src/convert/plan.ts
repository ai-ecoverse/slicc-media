import { UsageError } from '../context.ts';
import type { Invocation } from './args.ts';

export type Container =
  | 'mp4'
  | 'mov'
  | 'webm'
  | 'mkv'
  | 'mp3'
  | 'wav'
  | 'ogg'
  | 'flac'
  | 'adts'
  | 'mpegts';

export type VideoCodecName = 'avc' | 'hevc' | 'vp8' | 'vp9' | 'av1';

export type AudioCodecName =
  | 'aac'
  | 'opus'
  | 'mp3'
  | 'vorbis'
  | 'flac'
  | 'pcm-s16'
  | 'pcm-s16be'
  | 'pcm-s24'
  | 'pcm-s32'
  | 'pcm-f32'
  | 'pcm-u8'
  | 'pcm-s8'
  | 'ulaw'
  | 'alaw';

export type Quality = 'very_low' | 'low' | 'medium' | 'high' | 'very_high';

export interface VideoPlan {
  discard?: true;
  copy?: true;
  codec?: VideoCodecName;
  encoder?: string;
  bitrate?: number;
  quality?: Quality;
  width?: number;
  height?: number;
  fit?: 'fill' | 'contain' | 'cover';
  rotate?: 0 | 90 | 180 | 270;
  crop?: { left: number; top: number; width: number; height: number };
  frameRate?: number;
  keyFrameInterval?: number;
  forceTranscode?: boolean;
}

export interface AudioPlan {
  discard?: true;
  copy?: true;
  codec?: AudioCodecName;
  encoder?: string;
  bitrate?: number;
  quality?: Quality;
  numberOfChannels?: number;
  sampleRate?: number;
  forceTranscode?: boolean;
}

export interface Tags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  comment?: string;
  description?: string;
}

export interface Plan {
  container: Container;
  video: VideoPlan;
  audio: AudioPlan;
  trim?: { start?: number; end?: number };
  tags?: Tags;
  fastStart: false | 'in-memory' | 'fragmented';
  appendOnly: boolean;
}

function reject(reason: string): never {
  throw new UsageError(reason);
}

const IGNORED_TOGGLES = new Set(['-hide_banner', '-nostdin', '-sn', '-dn', '-copyts']);

const IGNORED_VALUE_FLAGS = new Set([
  '-threads',
  '-preset',
  '-tune',
  '-max_muxing_queue_size',
  '-strict',
  '-stats_period',
  '-maxrate',
  '-bufsize',
  '-vsync',
  '-fps_mode',
  '-avoid_negative_ts',
]);

export const VIDEO_CODECS: Record<string, VideoCodecName | 'copy'> = {
  copy: 'copy',
  libx264: 'avc',
  h264: 'avc',
  libx265: 'hevc',
  hevc: 'hevc',
  libvpx: 'vp8',
  vp8: 'vp8',
  'libvpx-vp9': 'vp9',
  vp9: 'vp9',
  'libaom-av1': 'av1',
  libsvtav1: 'av1',
  av1: 'av1',
};

export const AUDIO_CODECS: Record<string, AudioCodecName | 'copy'> = {
  copy: 'copy',
  aac: 'aac',
  libopus: 'opus',
  opus: 'opus',
  libmp3lame: 'mp3',
  mp3: 'mp3',
  libvorbis: 'vorbis',
  vorbis: 'vorbis',
  flac: 'flac',
  pcm_s16le: 'pcm-s16',
  pcm_s16be: 'pcm-s16be',
  pcm_s24le: 'pcm-s24',
  pcm_s32le: 'pcm-s32',
  pcm_f32le: 'pcm-f32',
  pcm_u8: 'pcm-u8',
  pcm_s8: 'pcm-s8',
  pcm_mulaw: 'ulaw',
  pcm_alaw: 'alaw',
};

export const CONTAINERS: Record<string, Container> = {
  mp4: 'mp4',
  m4v: 'mp4',
  m4a: 'mp4',
  mov: 'mov',
  webm: 'webm',
  matroska: 'mkv',
  mkv: 'mkv',
  mka: 'mkv',
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  flac: 'flac',
  adts: 'adts',
  aac: 'adts',
  mpegts: 'mpegts',
  ts: 'mpegts',
};

const INPUT_FORMATS = new Set([
  'mp4',
  'mov',
  'matroska',
  'webm',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'aac',
  'mpegts',
]);

const PIPE_CONTAINERS = new Set<Container>([
  'mp4',
  'mov',
  'webm',
  'mkv',
  'mpegts',
  'ogg',
  'adts',
  'mp3',
]);

const INTERNAL_BITSTREAM_FILTERS = new Set(['h264_mp4toannexb', 'aac_adtstoasc']);

const TAG_KEYS: Record<string, keyof Tags> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  album_artist: 'albumArtist',
  genre: 'genre',
  comment: 'comment',
  description: 'description',
};

export function parseTime(raw: string): number {
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(raw);
  if (ms) return Number(ms[1]) / 1000;
  const s = /^(\d+(?:\.\d+)?)s?$/.exec(raw);
  if (s) return Number(s[1]);
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(raw);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  return reject(`cannot parse time '${raw}'`);
}

export function parseBitrate(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(raw);
  if (!m) return reject(`cannot parse bitrate '${raw}'`);
  const scale = m[2] === undefined ? 1 : /k/i.test(m[2]) ? 1000 : 1_000_000;
  return Math.round(Number(m[1]) * scale);
}

function parsePositiveInt(raw: string, what: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return reject(`${what} must be a positive integer`);
  return Number(raw);
}

export function crfToQuality(crf: number): Quality {
  if (crf <= 18) return 'very_high';
  if (crf <= 23) return 'high';
  if (crf <= 28) return 'medium';
  if (crf <= 35) return 'low';
  return 'very_low';
}

export function audioQscaleToQuality(q: number): Quality {
  if (q <= 1) return 'very_high';
  if (q <= 3) return 'high';
  if (q <= 5) return 'medium';
  if (q <= 7) return 'low';
  return 'very_low';
}

function parseScale(args: string, video: VideoPlan): void {
  const named: Record<string, string> = {};
  const positional: string[] = [];
  for (const part of args.split(':')) {
    const eq = part.indexOf('=');
    if (eq >= 0) named[part.slice(0, eq)] = part.slice(eq + 1);
    else positional.push(part);
  }
  const w = named.w ?? named.width ?? positional[0];
  const h = named.h ?? named.height ?? positional[1];
  if (w === undefined || h === undefined) reject('scale needs both a width and a height');
  const dim = (raw: string, what: string): number | undefined => {
    if (raw === '-1' || raw === '-2') return undefined;
    if (!/^\d+$/.test(raw)) reject(`scale ${what} '${raw}' is an expression, not a size`);
    return Number(raw);
  };
  const width = dim(w, 'width');
  const height = dim(h, 'height');
  if (width === undefined && height === undefined) reject('scale keeps both dimensions');
  if (width !== undefined) video.width = width;
  if (height !== undefined) video.height = height;
  if (width !== undefined && height !== undefined) video.fit = 'fill';
}

function parseCrop(args: string, video: VideoPlan): void {
  const parts = args.split(':');
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) {
    reject('crop needs four integers (w:h:x:y); centred and expression crops are not supported');
  }
  const [width, height, left, top] = parts.map(Number);
  video.crop = { left, top, width, height };
}

interface Chain {
  resized: boolean;
  rotated: boolean;
}

function applyScale(args: string, video: VideoPlan, chain: Chain): void {
  if (chain.rotated) reject('scale after transpose: rotation and resize order is not expressible');
  parseScale(args, video);
  chain.resized = true;
}

function applyCrop(args: string, video: VideoPlan, chain: Chain): void {
  if (chain.resized || chain.rotated)
    reject('crop after scale or transpose: the source is cropped first');
  parseCrop(args, video);
}

function applyTranspose(args: string, video: VideoPlan, chain: Chain): void {
  if (chain.resized || video.crop)
    reject('transpose combined with scale or crop is not expressible');
  if (args === '1' || args === 'clock') video.rotate = 90;
  else if (args === '2' || args === 'cclock') video.rotate = 270;
  else reject(`transpose=${args} flips as well as rotates`);
  chain.rotated = true;
}

function applyFps(args: string, video: VideoPlan): void {
  video.frameRate = Number(args.replace(/^fps=/, ''));
  if (!(video.frameRate > 0)) reject(`fps '${args}' is not a number`);
}

function parseVideoFilter(spec: string, video: VideoPlan): void {
  const chain: Chain = { resized: false, rotated: false };
  for (const filter of spec.split(',')) {
    const eq = filter.indexOf('=');
    const name = (eq >= 0 ? filter.slice(0, eq) : filter).trim();
    const args = eq >= 0 ? filter.slice(eq + 1) : '';
    if (name === 'scale') applyScale(args, video, chain);
    else if (name === 'crop') applyCrop(args, video, chain);
    else if (name === 'transpose') applyTranspose(args, video, chain);
    else if (name === 'fps') applyFps(args, video);
    else if (name !== 'format') reject(`video filter '${name}' has no WebCodecs equivalent`);
    else if (args !== 'yuv420p') reject(`format=${args} has no WebCodecs equivalent`);
  }
}

function parseAudioFilter(spec: string, audio: AudioPlan): void {
  for (const filter of spec.split(',')) {
    const m = /^aresample=(?:osr=)?(\d+)$/.exec(filter.trim());
    if (!m) reject(`audio filter '${filter}' has no WebCodecs equivalent`);
    audio.sampleRate = Number(m[1]);
  }
}

interface Walk {
  plan: Plan;
  container?: Container;
  gop?: number;
  frameRateGiven: boolean;
}

function setVideoCodec(walk: Walk, raw: string): void {
  const codec = VIDEO_CODECS[raw];
  if (!codec) reject(`unknown or unsupported video encoder '${raw}' (see -encoders)`);
  const video = walk.plan.video;
  delete video.copy;
  delete video.codec;
  delete video.encoder;
  if (codec === 'copy') video.copy = true;
  else Object.assign(video, { codec, encoder: raw });
}

function setAudioCodec(walk: Walk, raw: string): void {
  const codec = AUDIO_CODECS[raw];
  if (!codec) reject(`unknown or unsupported audio encoder '${raw}' (see -encoders)`);
  const audio = walk.plan.audio;
  delete audio.copy;
  delete audio.codec;
  delete audio.encoder;
  if (codec === 'copy') audio.copy = true;
  else Object.assign(audio, { codec, encoder: raw });
}

function setMovflags(walk: Walk, raw: string): void {
  for (const flag of raw.split('+').filter(Boolean)) {
    if (flag === 'faststart') walk.plan.fastStart = 'in-memory';
    else if (flag === 'frag_keyframe' || flag === 'empty_moov' || flag === 'default_base_moof') {
      walk.plan.fastStart = 'fragmented';
    } else reject(`-movflags ${flag} is not supported`);
  }
}

function setTag(walk: Walk, raw: string): void {
  const eq = raw.indexOf('=');
  if (eq < 0) reject(`-metadata '${raw}' is not key=value`);
  const key = TAG_KEYS[raw.slice(0, eq)];
  if (!key) reject(`-metadata ${raw.slice(0, eq)} is not a tag that can be written`);
  walk.plan.tags = { ...walk.plan.tags, [key]: raw.slice(eq + 1) };
}

function setTrim(walk: Walk, flag: string, value: string): void {
  if (flag === '-ss') walk.plan.trim = { ...walk.plan.trim, start: parseTime(value) };
  else if (flag === '-t') {
    walk.plan.trim = { ...walk.plan.trim, end: (walk.plan.trim?.start ?? 0) + parseTime(value) };
  } else walk.plan.trim = { ...walk.plan.trim, end: parseTime(value) };
}

function applyValueOption(walk: Walk, flag: string, value: string): boolean {
  const { video, audio } = walk.plan;
  switch (flag) {
    case '-c':
    case '-codec':
      if (value !== 'copy')
        reject(`-c ${value} names one encoder for every stream; use -c:v and -c:a`);
      setVideoCodec(walk, value);
      setAudioCodec(walk, value);
      return true;
    case '-c:v':
    case '-vcodec':
    case '-codec:v':
      setVideoCodec(walk, value);
      return true;
    case '-c:a':
    case '-acodec':
    case '-codec:a':
      setAudioCodec(walk, value);
      return true;
    case '-b:v':
    case '-vb':
    case '-b':
      video.bitrate = parseBitrate(value);
      return true;
    case '-b:a':
    case '-ab':
      audio.bitrate = parseBitrate(value);
      return true;
    case '-crf':
      video.quality = crfToQuality(Number(value));
      return true;
    case '-q:a':
    case '-qscale:a':
      audio.quality = audioQscaleToQuality(Number(value));
      return true;
    case '-ac':
      audio.numberOfChannels = parsePositiveInt(value, '-ac');
      return true;
    case '-ar':
      audio.sampleRate = parsePositiveInt(value, '-ar');
      return true;
    case '-r':
    case '-r:v':
      video.frameRate = Number(value);
      if (!(video.frameRate > 0)) reject(`-r '${value}' is not a frame rate`);
      walk.frameRateGiven = true;
      return true;
    case '-g':
      walk.gop = parsePositiveInt(value, '-g');
      return true;
    case '-s':
    case '-s:v': {
      const m = /^(\d+)x(\d+)$/.exec(value);
      if (!m) return reject(`-s '${value}' is not WxH`);
      Object.assign(video, { width: Number(m[1]), height: Number(m[2]), fit: 'fill' });
      return true;
    }
    case '-vf':
    case '-filter:v':
      parseVideoFilter(value, video);
      return true;
    case '-af':
    case '-filter:a':
      parseAudioFilter(value, audio);
      return true;
    case '-pix_fmt':
      if (value !== 'yuv420p') reject(`-pix_fmt ${value} has no WebCodecs equivalent`);
      return true;
    case '-movflags':
      setMovflags(walk, value);
      return true;
    case '-f':
      walk.container =
        CONTAINERS[value] ?? reject(`muxer '${value}' is not supported (see -formats)`);
      return true;
    case '-map':
      if (value !== '0') reject(`-map ${value}: only '-map 0' is supported`);
      return true;
    case '-metadata':
      setTag(walk, value);
      return true;
    case '-ss':
    case '-t':
    case '-to':
      setTrim(walk, flag, value);
      return true;
    case '-bsf':
    case '-bsf:v':
    case '-bsf:a':
      if (!INTERNAL_BITSTREAM_FILTERS.has(value))
        reject(`bitstream filter '${value}' is not supported`);
      return true;
    case '-filter_complex':
      return reject('-filter_complex is not supported: there are no filter graphs here');
  }
  return IGNORED_VALUE_FLAGS.has(flag);
}

function walkOutputOptions(walk: Walk, opts: string[]): void {
  for (let i = 0; i < opts.length; i++) {
    const tok = opts[i];
    const flag = tok.replace(/:\d+$/, '');
    if (IGNORED_TOGGLES.has(flag)) continue;
    if (flag === '-shortest')
      reject('-shortest is not supported; every track is written to its end');
    if (flag === '-an') {
      walk.plan.audio = { discard: true };
      continue;
    }
    if (flag === '-vn') {
      walk.plan.video = { discard: true };
      continue;
    }
    const value = opts[i + 1];
    if (value === undefined || !applyValueOption(walk, flag, value)) {
      reject(`option ${tok} is not supported`);
    }
    i += 1;
  }
}

function walkInputOptions(walk: Walk, raw: string[]): void {
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (tok === '-i') {
      i += 1;
      continue;
    }
    if (IGNORED_TOGGLES.has(tok)) continue;
    const value = raw[i + 1];
    if (value === undefined) reject(`input option ${tok} is not supported`);
    if (tok === '-ss' || tok === '-t' || tok === '-to') setTrim(walk, tok, value);
    else if (tok === '-f') {
      if (!INPUT_FORMATS.has(value))
        reject(`input format '${value}' is not supported (see -formats)`);
    } else if (!IGNORED_VALUE_FLAGS.has(tok)) reject(`input option ${tok} is not supported`);
    i += 1;
  }
}

function containerFromOutput(outputPath: string): Container {
  const ext = /\.([A-Za-z0-9]+)$/.exec(outputPath)?.[1]?.toLowerCase();
  const container = ext ? CONTAINERS[ext] : undefined;
  return (
    container ??
    reject(`unable to choose an output format for '${outputPath}'; use -f (see -formats)`)
  );
}

function checkPipe(plan: Plan, pipe: boolean): void {
  const mp4 = plan.container === 'mp4' || plan.container === 'mov';
  if (plan.fastStart !== false && !mp4) reject('-movflags only applies to mp4 and mov output');
  if (!pipe) return;
  if (!PIPE_CONTAINERS.has(plan.container)) {
    reject(
      `${plan.container} can't be written to a pipe; write a file, or use -f ${[...PIPE_CONTAINERS].join(', ')}`
    );
  }
  if (plan.fastStart === 'in-memory') reject('-movflags faststart needs a file, not a pipe');
  if (mp4) plan.fastStart = 'fragmented';
  plan.appendOnly = true;
}

function checkStreams(plan: Plan): void {
  const v = plan.video;
  const a = plan.audio;
  if (!v.discard && (v.codec || v.bitrate !== undefined || v.quality)) v.forceTranscode = true;
  if (!a.discard && (a.codec || a.bitrate !== undefined || a.quality)) a.forceTranscode = true;
  const videoChanged = [v.width, v.height, v.crop, v.rotate, v.frameRate, v.bitrate, v.quality];
  if (v.copy && videoChanged.some((x) => x !== undefined)) {
    reject('-c:v copy cannot be combined with video filters, a frame rate or a bitrate');
  }
  const audioChanged = [a.numberOfChannels, a.sampleRate, a.bitrate, a.quality];
  if (a.copy && audioChanged.some((x) => x !== undefined)) {
    reject('-c:a copy cannot be combined with -ac, -ar or a bitrate');
  }
  if (v.discard && a.discard) reject('-an with -vn leaves nothing to write');
}

function finalize(walk: Walk, outputPath: string, pipe: boolean): Plan {
  const { plan } = walk;
  plan.container = walk.container ?? containerFromOutput(outputPath);
  checkPipe(plan, pipe);
  if (walk.gop !== undefined) {
    if (!walk.frameRateGiven) reject('-g needs -r, so the interval can be expressed in seconds');
    plan.video.keyFrameInterval = walk.gop / (plan.video.frameRate as number);
  }
  const trim = plan.trim;
  if (trim?.start !== undefined && trim.end !== undefined && trim.end <= trim.start) {
    reject('the trim end is not after its start');
  }
  checkStreams(plan);
  return plan;
}

export function makePlan(inv: Invocation, pipe: boolean): Plan {
  if (inv.inputs.length === 0) reject('no input given (-i FILE)');
  if (inv.inputs.length > 1) reject('more than one input is not supported yet');
  if (inv.outputPath === null) reject('at least one output file must be specified');
  if (inv.outputs > 1) reject('more than one output is not supported yet');
  const [input] = inv.inputs;
  if (input.format === 'lavfi') reject('-f lavfi test sources are not supported yet');
  const walk: Walk = {
    plan: { container: 'mp4', video: {}, audio: {}, fastStart: false, appendOnly: false },
    frameRateGiven: false,
  };
  walkInputOptions(walk, input.raw);
  walkOutputOptions(walk, inv.outputOpts);
  return finalize(walk, inv.outputPath, pipe);
}
