import {
  AdtsOutputFormat,
  ALL_FORMATS,
  Conversion,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
  type DiscardedTrack,
  FlacOutputFormat,
  Input,
  type Quality as MbQuality,
  MkvOutputFormat,
  MovOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  MpegTsOutputFormat,
  OggOutputFormat,
  Output,
  type OutputFormat,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  QUALITY_VERY_LOW,
  type Source,
  type Target,
  WavOutputFormat,
  WebMOutputFormat,
} from 'mediabunny';
import { hasWebCodecs, message } from '../context.ts';
import { codecName } from '../probe/info.ts';
import type { AudioPlan, Plan, Quality, VideoPlan } from './plan.ts';

export class ConvertError extends Error {}

const QUALITIES: Record<Quality, MbQuality> = {
  very_low: QUALITY_VERY_LOW,
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  very_high: QUALITY_VERY_HIGH,
};

export function outputFormatFor(plan: Plan): OutputFormat {
  switch (plan.container) {
    case 'mp4':
      return new Mp4OutputFormat({ fastStart: plan.fastStart });
    case 'mov':
      return new MovOutputFormat({ fastStart: plan.fastStart });
    case 'webm':
      return new WebMOutputFormat({ appendOnly: plan.appendOnly });
    case 'mkv':
      return new MkvOutputFormat({ appendOnly: plan.appendOnly });
    case 'mp3':
      return new Mp3OutputFormat();
    case 'wav':
      return new WavOutputFormat();
    case 'ogg':
      return new OggOutputFormat();
    case 'flac':
      return new FlacOutputFormat();
    case 'adts':
      return new AdtsOutputFormat();
    case 'mpegts':
      return new MpegTsOutputFormat();
  }
}

export function videoOptions(video: VideoPlan): ConversionVideoOptions {
  if (video.discard) return { discard: true };
  const out: ConversionVideoOptions = {};
  if (video.codec) out.codec = video.codec;
  if (video.bitrate !== undefined) out.bitrate = video.bitrate;
  else if (video.quality) out.bitrate = QUALITIES[video.quality];
  if (video.width !== undefined) out.width = video.width;
  if (video.height !== undefined) out.height = video.height;
  if (video.fit) out.fit = video.fit;
  if (video.rotate !== undefined) out.rotate = video.rotate;
  if (video.crop) out.crop = video.crop;
  if (video.frameRate !== undefined) out.frameRate = video.frameRate;
  if (video.keyFrameInterval !== undefined) out.keyFrameInterval = video.keyFrameInterval;
  if (video.forceTranscode) out.forceTranscode = true;
  return out;
}

export function audioOptions(audio: AudioPlan): ConversionAudioOptions {
  if (audio.discard) return { discard: true };
  const out: ConversionAudioOptions = {};
  if (audio.codec) out.codec = audio.codec;
  if (audio.bitrate !== undefined) out.bitrate = audio.bitrate;
  else if (audio.quality) out.bitrate = QUALITIES[audio.quality];
  if (audio.numberOfChannels !== undefined) out.numberOfChannels = audio.numberOfChannels;
  if (audio.sampleRate !== undefined) out.sampleRate = audio.sampleRate;
  if (audio.forceTranscode) out.forceTranscode = true;
  return out;
}

const NO_WEBCODECS =
  'WebCodecs is not available in this runtime; probing, stream copy (-c copy) and PCM work, re-encoding needs a browser';

export function explainDiscard(d: DiscardedTrack, plan: Plan): string {
  const type = d.track.type;
  const source = codecName(d.track.codec) ?? 'unknown';
  const wanted = type === 'video' ? plan.video : plan.audio;
  const target = wanted.encoder ?? `any ${type} codec ${plan.container} can hold`;
  const why = hasWebCodecs() ? 'this browser has none' : NO_WEBCODECS;
  switch (d.reason) {
    case 'undecodable_source_codec':
      return `${type} stream #0:${d.track.id - 1}: no decoder for '${source}' (${why})`;
    case 'cannot_copy':
      return `${type} stream #0:${d.track.id - 1}: '${source}' cannot be stream-copied into ${plan.container} here; re-encode it with -c:${type[0]}`;
    case 'max_track_count_reached':
    case 'max_track_count_of_type_reached':
      return `${type} stream #0:${d.track.id - 1}: ${plan.container} can't hold it; drop it with -${type[0]}n`;
    case 'no_encodable_target_codec':
      return `${type} stream #0:${d.track.id - 1}: no encoder for ${target} (${why})`;
    default:
      return `${type} stream #0:${d.track.id - 1}: ${d.reason.replace(/_/g, ' ')}`;
  }
}

export function copyViolations(conversion: Conversion, format: OutputFormat, plan: Plan): string[] {
  const supported = new Set<string>(format.getSupportedCodecs());
  const problems: string[] = [];
  for (const track of conversion.utilizedTracks) {
    const copy = track.type === 'video' ? plan.video.copy : plan.audio.copy;
    if (copy && (track.codec === null || !supported.has(track.codec))) {
      problems.push(
        `${track.type} stream #0:${track.id - 1}: '${codecName(track.codec) ?? 'unknown'}' cannot be stream-copied into ${plan.container}`
      );
    }
  }
  return problems;
}

function copyOnly(plan: Plan): boolean {
  return !!(plan.video.discard || plan.video.copy) && !!(plan.audio.discard || plan.audio.copy);
}

export interface RunOptions {
  plan: Plan;
  source: Source;
  target: Target;
  onProgress?: (fraction: number, seconds: number) => void;
  onConversion?: (conversion: Conversion) => void;
  canceled?: () => boolean;
}

export async function convert(options: RunOptions): Promise<'done' | 'canceled'> {
  const input = new Input({ source: options.source, formats: ALL_FORMATS });
  try {
    await input.getFormat().catch(() => {
      throw new ConvertError('Invalid data found when processing input');
    });
    const format = outputFormatFor(options.plan);
    const output = new Output({ format, target: options.target });
    const conversion = await Conversion.init({
      input,
      output,
      video: videoOptions(options.plan.video),
      audio: audioOptions(options.plan.audio),
      ...(options.plan.trim ? { trim: options.plan.trim } : {}),
      ...(options.plan.tags ? { tags: options.plan.tags } : {}),
      copy: { mode: copyOnly(options.plan) ? 'forced' : 'preferred', shiftTolerance: Infinity },
      showWarnings: false,
    }).catch((err) => {
      throw new ConvertError(message(err));
    });
    const involuntary = conversion.discardedTracks.filter((d) => d.reason !== 'discarded_by_user');
    const problems = [
      ...involuntary.map((d) => explainDiscard(d, options.plan)),
      ...copyViolations(conversion, format, options.plan),
    ];
    if (problems.length > 0) throw new ConvertError(problems.join('\n'));
    if (!conversion.isValid) throw new ConvertError('output file does not contain any stream');
    conversion.onProgress = options.onProgress;
    options.onConversion?.(conversion);
    try {
      await conversion.execute();
    } catch (err) {
      if (options.canceled?.()) return 'canceled';
      throw err;
    }
    return 'done';
  } finally {
    input.dispose();
  }
}
