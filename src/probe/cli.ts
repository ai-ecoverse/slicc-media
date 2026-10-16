import { type Context, message, UsageError } from '../context.ts';
import { openSource } from '../io.ts';
import { type ProbeFormat, type ProbeInfo, type ProbeStream, probe } from './info.ts';

type OutputFormat =
  | { kind: 'json' }
  | { kind: 'csv'; printSection: boolean }
  | { kind: 'default'; noWrappers: boolean; noKey: boolean };

interface ShowEntries {
  format?: Set<string>;
  stream?: Set<string>;
}

export interface ProbeArgs {
  inputPath: string | null;
  showFormat: boolean;
  showStreams: boolean;
  showEntries: ShowEntries | null;
  selectStreams: string | null;
  countPackets: boolean;
  outputFormat: OutputFormat;
  quiet: boolean;
  structured: boolean;
}

const NAME = 'mediaprobe';

export const PROBE_HELP = `usage: ${NAME} [options] <input>

Reads a media file's container index with mediabunny and prints its format
and streams in ffprobe's field names. It decodes nothing, so it works for
every container mediabunny reads (mp4/mov, webm/mkv, mp3, wav, ogg, flac,
aac, mpegts), even when this browser has no decoder for the codec.
It is not FFmpeg's ffprobe.

  -i FILE                 input; '-' or pipe:0 reads stdin
  -show_format            the format section
  -show_streams           the streams section
  -show_entries SPEC      format=a,b:stream=c,d
  -select_streams SPEC    v, a, v:N or a:N
  -count_packets          adds nb_read_packets to each stream
  -of, -print_format FMT  json, csv[=p=0] or default[=nw=1:nk=1]
  -v, -loglevel LEVEL     quiet, error, warning, info
  -hide_banner            accepted, there is no banner

  format:  filename, nb_streams, format_name, duration, start_time, size, bit_rate
  streams: index, codec_type, codec_name, width, height, r_frame_rate,
           avg_frame_rate, sample_rate, channels, channel_layout, bit_rate,
           duration, nb_read_packets
`;

function requireValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

function parseOutputFormat(raw: string): OutputFormat {
  const eq = raw.indexOf('=');
  const name = eq < 0 ? raw : raw.slice(0, eq);
  const opts = eq < 0 ? '' : raw.slice(eq + 1);
  if (name === 'json') return { kind: 'json' };
  if (name === 'csv') return { kind: 'csv', printSection: !/(?:^|:)p=0(?::|$)/.test(opts) };
  if (name === 'default') {
    return {
      kind: 'default',
      noWrappers: /(?:^|:)(?:nw|noprint_wrappers)=1(?::|$)/.test(opts),
      noKey: /(?:^|:)(?:nk|nokey)=1(?::|$)/.test(opts),
    };
  }
  throw new UsageError(
    `unsupported -of '${raw}' (supported: json, csv[=p=0], default[=nw=1:nk=1])`
  );
}

function parseShowEntries(raw: string): ShowEntries {
  const out: ShowEntries = {};
  for (const section of raw.split(':').filter(Boolean)) {
    const eq = section.indexOf('=');
    if (eq < 0) throw new UsageError(`-show_entries section '${section}' needs keys`);
    const name = section.slice(0, eq);
    const keys = new Set(
      section
        .slice(eq + 1)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
    );
    if (name === 'format') out.format = keys;
    else if (name === 'stream') out.stream = keys;
    else throw new UsageError(`unsupported -show_entries section '${name}' (format, stream)`);
  }
  return out;
}

function applyArg(parsed: ProbeArgs, args: string[], i: number): number {
  const arg = args[i];
  switch (arg) {
    case '-i':
      parsed.inputPath = requireValue(args, i, arg);
      return i + 1;
    case '-show_format':
      parsed.showFormat = true;
      parsed.structured = true;
      return i;
    case '-show_streams':
      parsed.showStreams = true;
      parsed.structured = true;
      return i;
    case '-count_packets':
      parsed.countPackets = true;
      return i;
    case '-show_entries':
      parsed.showEntries = parseShowEntries(requireValue(args, i, arg));
      parsed.structured = true;
      return i + 1;
    case '-select_streams':
      parsed.selectStreams = requireValue(args, i, arg);
      return i + 1;
    case '-of':
    case '-print_format':
      parsed.outputFormat = parseOutputFormat(requireValue(args, i, arg));
      parsed.structured = true;
      return i + 1;
    case '-v':
    case '-loglevel':
      parsed.quiet = ['quiet', 'panic', '-8'].includes(requireValue(args, i, arg).toLowerCase());
      return i + 1;
    case '-hide_banner':
      return i;
  }
  if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unsupported option '${arg}'`);
  if (parsed.inputPath !== null) throw new UsageError(`unexpected argument '${arg}'`);
  parsed.inputPath = arg;
  return i;
}

export function parseProbeArgs(args: string[]): ProbeArgs {
  const parsed: ProbeArgs = {
    inputPath: null,
    showFormat: false,
    showStreams: false,
    showEntries: null,
    selectStreams: null,
    countPackets: false,
    outputFormat: { kind: 'default', noWrappers: false, noKey: false },
    quiet: false,
    structured: false,
  };
  for (let i = 0; i < args.length; i++) i = applyArg(parsed, args, i);
  if (!parsed.showFormat && !parsed.showStreams && !parsed.showEntries) {
    parsed.showFormat = true;
    parsed.showStreams = true;
  }
  return parsed;
}

export function selectStreams(streams: ProbeStream[], spec: string | null): ProbeStream[] {
  if (!spec) return streams;
  const m = /^([va])(?::(\d+))?$/.exec(spec.trim());
  if (!m) throw new UsageError(`unsupported -select_streams '${spec}' (v, a, v:N, a:N)`);
  const typed = streams.filter((s) => s.codec_type === (m[1] === 'v' ? 'video' : 'audio'));
  if (m[2] === undefined) return typed;
  const hit = typed[Number(m[2])];
  return hit ? [hit] : [];
}

type Fields = Record<string, string | number>;

const FORMAT_KEYS = [
  'filename',
  'nb_streams',
  'format_name',
  'duration',
  'start_time',
  'size',
  'bit_rate',
] as const satisfies ReadonlyArray<keyof ProbeFormat>;

const STREAM_KEYS = [
  'index',
  'codec_type',
  'codec_name',
  'width',
  'height',
  'r_frame_rate',
  'avg_frame_rate',
  'sample_rate',
  'channels',
  'channel_layout',
  'bit_rate',
  'duration',
  'nb_read_packets',
] as const satisfies ReadonlyArray<keyof ProbeStream>;

function pick<T extends object>(obj: T, keys: readonly (keyof T)[], only?: Set<string>): Fields {
  const out: Fields = {};
  for (const key of keys) {
    if (only && !only.has(key as string)) continue;
    const value = obj[key];
    if (typeof value === 'string' || typeof value === 'number') out[key as string] = value;
  }
  return out;
}

interface Sections {
  format?: Fields;
  streams?: Fields[];
}

function sections(info: ProbeInfo, parsed: ProbeArgs): Sections {
  const streams = selectStreams(info.streams, parsed.selectStreams);
  const out: Sections = {};
  const entries = parsed.showEntries;
  if (entries) {
    if (entries.stream) out.streams = streams.map((s) => pick(s, STREAM_KEYS, entries.stream));
    if (entries.format) out.format = pick(info.format, FORMAT_KEYS, entries.format);
    return out;
  }
  if (parsed.showStreams) out.streams = streams.map((s) => pick(s, STREAM_KEYS));
  if (parsed.showFormat) out.format = pick(info.format, FORMAT_KEYS);
  return out;
}

function renderDefault(s: Sections, fmt: Extract<OutputFormat, { kind: 'default' }>): string {
  const lines: string[] = [];
  const emit = (name: string, obj: Fields): void => {
    if (!fmt.noWrappers) lines.push(`[${name}]`);
    for (const [k, v] of Object.entries(obj)) lines.push(fmt.noKey ? String(v) : `${k}=${v}`);
    if (!fmt.noWrappers) lines.push(`[/${name}]`);
  };
  for (const stream of s.streams ?? []) emit('STREAM', stream);
  if (s.format) emit('FORMAT', s.format);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function renderCsv(s: Sections, fmt: Extract<OutputFormat, { kind: 'csv' }>): string {
  const lines: string[] = [];
  const row = (section: string, obj: Fields): void => {
    const values = Object.values(obj).map((v) => csvEscape(String(v)));
    if (values.length === 0) return;
    if (fmt.printSection) values.unshift(section);
    lines.push(values.join(','));
  };
  for (const stream of s.streams ?? []) row('stream', stream);
  if (s.format) row('format', s.format);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function humanStream(s: ProbeStream): string {
  const codec = s.codec_name ?? 'unknown';
  if (s.codec_type === 'video') {
    const fps = s.r_frame_rate ? `, ${s.r_frame_rate} fps` : '';
    return `  Stream #0:${s.index}: Video: ${codec}, ${s.width}x${s.height}${fps}`;
  }
  if (s.codec_type === 'audio') {
    return `  Stream #0:${s.index}: Audio: ${codec}, ${s.sample_rate} Hz, ${s.channel_layout}`;
  }
  return `  Stream #0:${s.index}: ${s.codec_type}: ${codec}`;
}

function renderHuman(info: ProbeInfo): string {
  const f = info.format;
  const br = f.bit_rate ? `${Math.round(Number(f.bit_rate) / 1000)} kb/s` : 'N/A';
  const lines = [
    `Input #0, ${f.format_name}, from '${f.filename}':`,
    `  Duration: ${f.duration} s, start: ${f.start_time}, bitrate: ${br}`,
  ];
  for (const s of info.streams) lines.push(humanStream(s));
  return `${lines.join('\n')}\n`;
}

export function render(info: ProbeInfo, parsed: ProbeArgs): string {
  if (!parsed.structured) return renderHuman(info);
  const s = sections(info, parsed);
  if (parsed.outputFormat.kind === 'json') return `${JSON.stringify(s, null, 4)}\n`;
  if (parsed.outputFormat.kind === 'csv') return renderCsv(s, parsed.outputFormat);
  return renderDefault(s, parsed.outputFormat);
}

export async function runProbe(ctx: Context, args: string[]): Promise<number> {
  if (args.length === 0) {
    await ctx.write(2, `${PROBE_HELP}\n${NAME}: no input given\n`);
    return 1;
  }
  if (args.includes('-h') || args.includes('-help') || args.includes('--help')) {
    await ctx.write(1, PROBE_HELP);
    return 0;
  }
  let parsed: ProbeArgs;
  try {
    parsed = parseProbeArgs(args);
    if (parsed.inputPath === null) throw new UsageError('no input given');
    selectStreams([], parsed.selectStreams);
  } catch (err) {
    await ctx.write(2, `${NAME}: ${message(err)}\n`);
    return 1;
  }
  const name = parsed.inputPath;
  let opened: Awaited<ReturnType<typeof openSource>>;
  try {
    opened = await openSource(ctx, name);
  } catch (err) {
    if (!parsed.quiet) await ctx.write(2, `${name}: ${message(err)}\n`);
    return 1;
  }
  try {
    const info = await probe(opened.source, {
      filename: name,
      size: opened.size,
      packets: parsed.countPackets,
    });
    await ctx.write(1, render(info, parsed));
    return 0;
  } catch (err) {
    if (!parsed.quiet) await ctx.write(2, `${name}: ${message(err)}\n`);
    return 1;
  } finally {
    await opened.close();
  }
}
