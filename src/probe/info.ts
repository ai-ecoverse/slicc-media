import {
  ALL_FORMATS,
  EncodedPacketSink,
  Input,
  type InputAudioTrack,
  type InputTrack,
  type InputVideoTrack,
  type MetadataTags,
  type Source,
} from 'mediabunny';

export interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  duration?: string;
  nb_read_packets?: string;
  tags?: Record<string, string>;
}

export interface ProbeFormat {
  filename?: string;
  nb_streams?: number;
  format_name?: string;
  duration?: string;
  start_time?: string;
  size?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
}

export interface ProbeInfo {
  format: ProbeFormat;
  streams: ProbeStream[];
}

export const CODEC_NAMES: Record<string, string> = {
  avc: 'h264',
  hevc: 'hevc',
  vp8: 'vp8',
  vp9: 'vp9',
  av1: 'av1',
  aac: 'aac',
  opus: 'opus',
  mp3: 'mp3',
  vorbis: 'vorbis',
  flac: 'flac',
  ac3: 'ac3',
  eac3: 'eac3',
  'pcm-s16': 'pcm_s16le',
  'pcm-s16be': 'pcm_s16be',
  'pcm-s24': 'pcm_s24le',
  'pcm-s24be': 'pcm_s24be',
  'pcm-s32': 'pcm_s32le',
  'pcm-s32be': 'pcm_s32be',
  'pcm-f32': 'pcm_f32le',
  'pcm-f32be': 'pcm_f32be',
  'pcm-f64': 'pcm_f64le',
  'pcm-f64be': 'pcm_f64be',
  'pcm-u8': 'pcm_u8',
  'pcm-s8': 'pcm_s8',
  ulaw: 'pcm_mulaw',
  alaw: 'pcm_alaw',
};

const FORMAT_NAMES: Record<string, string> = {
  'video/mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  'video/quicktime': 'mov,mp4,m4a,3gp,3g2,mj2',
  'video/webm': 'matroska,webm',
  'video/x-matroska': 'matroska,webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'video/MP2T': 'mpegts',
};

const CHANNEL_LAYOUTS: Record<number, string> = {
  1: 'mono',
  2: 'stereo',
  3: '2.1',
  4: 'quad',
  5: '5.0',
  6: '5.1',
  7: '6.1',
  8: '7.1',
};

export function formatName(mimeType: string, name: string): string {
  return FORMAT_NAMES[mimeType] ?? name.toLowerCase();
}

export function formatSeconds(seconds: number): string {
  return seconds.toFixed(6);
}

export function frameRateToRational(fps: number): string {
  if (!(fps > 0) || !Number.isFinite(fps)) return '0/0';
  for (const base of [24, 30, 60, 120]) {
    if (Math.abs(fps - (base * 1000) / 1001) < 0.001) return `${base * 1000}/1001`;
  }
  const rounded = Math.round(fps * 1000);
  return rounded % 1000 === 0 ? `${rounded / 1000}/1` : `${rounded}/1000`;
}

export function codecName(codec: string | null): string | undefined {
  if (codec === null) return undefined;
  return CODEC_NAMES[codec] ?? codec;
}

async function videoStream(track: InputVideoTrack, index: number): Promise<ProbeStream> {
  const stream: ProbeStream = { index, codec_type: 'video', codec_name: codecName(track.codec) };
  stream.width = track.displayWidth;
  stream.height = track.displayHeight;
  const metrics = await track.computeFrameRateMetrics().catch(() => null);
  if (metrics) {
    stream.r_frame_rate = frameRateToRational(
      metrics.underlyingFrameRate ?? metrics.bestGuessFrameRate
    );
    stream.avg_frame_rate = frameRateToRational(metrics.averageFrameRate);
  }
  return stream;
}

function audioStream(track: InputAudioTrack, index: number): ProbeStream {
  const channels = track.numberOfChannels;
  return {
    index,
    codec_type: 'audio',
    codec_name: codecName(track.codec),
    sample_rate: String(track.sampleRate),
    channels,
    channel_layout: CHANNEL_LAYOUTS[channels] ?? `${channels} channels`,
  };
}

async function countPackets(track: InputTrack): Promise<number> {
  let count = 0;
  const packets = new EncodedPacketSink(track).packets(undefined, undefined, {
    metadataOnly: true,
  });
  for await (const _ of packets) count++;
  return count;
}

export async function describeTrack(
  track: InputTrack,
  index: number,
  packets: boolean
): Promise<ProbeStream> {
  const stream: ProbeStream = track.isVideoTrack()
    ? await videoStream(track, index)
    : track.isAudioTrack()
      ? audioStream(track, index)
      : { index, codec_type: track.type, codec_name: codecName(track.codec) };
  const duration = await track.computeDuration().catch(() => null);
  if (duration !== null) stream.duration = formatSeconds(duration);
  const bitrate = await track.getBitrate().catch(() => null);
  if (bitrate !== null && bitrate > 0) stream.bit_rate = String(Math.round(bitrate));
  if (packets) stream.nb_read_packets = String(await countPackets(track));
  const language = track.languageCode;
  if (language && language !== 'und') stream.tags = { language };
  return stream;
}

function stringTags(tags: MetadataTags): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags.raw ?? {})) {
    if (typeof value === 'string') out[key] = value;
  }
  for (const key of ['title', 'artist', 'album', 'genre', 'comment', 'description'] as const) {
    const value = tags[key];
    if (typeof value === 'string' && !(key in out)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class NotMedia extends Error {}

export async function probe(
  source: Source,
  options: { filename: string; size: number | null; packets: boolean }
): Promise<ProbeInfo> {
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    const inputFormat = await input.getFormat().catch(() => {
      throw new NotMedia('Invalid data found when processing input');
    });
    const tracks = await input.getTracks();
    const duration = await input.computeDuration();
    const format: ProbeFormat = {
      filename: options.filename,
      nb_streams: tracks.length,
      format_name: formatName(inputFormat.mimeType, inputFormat.name),
      duration: formatSeconds(duration),
      start_time: formatSeconds(await input.getFirstTimestamp()),
    };
    if (options.size !== null) {
      format.size = String(options.size);
      if (duration > 0) format.bit_rate = String(Math.round((options.size * 8) / duration));
    }
    const tags = stringTags(await input.getMetadataTags());
    if (tags) format.tags = tags;
    const streams: ProbeStream[] = [];
    for (const [index, track] of tracks.entries()) {
      streams.push(await describeTrack(track, index, options.packets));
    }
    return { format, streams };
  } finally {
    input.dispose();
  }
}
