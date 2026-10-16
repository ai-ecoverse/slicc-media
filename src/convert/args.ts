import { UsageError } from '../context.ts';

export interface ParsedInput {
  path: string;
  format?: string;
  raw: string[];
}

export interface Invocation {
  inputs: ParsedInput[];
  outputOpts: string[];
  outputPath: string | null;
  outputs: number;
  overwrite: 'yes' | 'no' | 'ask';
  stats: boolean;
  loglevel: string;
}

const VALUE_TAKING_FLAGS = new Set([
  '-f',
  '-i',
  '-c',
  '-codec',
  '-c:v',
  '-c:a',
  '-codec:v',
  '-codec:a',
  '-vcodec',
  '-acodec',
  '-vf',
  '-af',
  '-filter:v',
  '-filter:a',
  '-filter_complex',
  '-r',
  '-r:v',
  '-b',
  '-b:v',
  '-b:a',
  '-vb',
  '-ab',
  '-s',
  '-s:v',
  '-t',
  '-ss',
  '-to',
  '-pix_fmt',
  '-ar',
  '-ac',
  '-frames:v',
  '-frames:a',
  '-q:v',
  '-q:a',
  '-qscale:a',
  '-crf',
  '-preset',
  '-tune',
  '-movflags',
  '-map',
  '-metadata',
  '-loglevel',
  '-v',
  '-threads',
  '-bsf',
  '-bsf:v',
  '-bsf:a',
  '-profile:v',
  '-level',
  '-g',
  '-maxrate',
  '-bufsize',
  '-max_muxing_queue_size',
  '-strict',
  '-vsync',
  '-fps_mode',
  '-avoid_negative_ts',
  '-stats_period',
]);

const BOOLEAN_FLAGS = new Set([
  '-y',
  '-n',
  '-vn',
  '-an',
  '-sn',
  '-dn',
  '-stats',
  '-nostats',
  '-nostdin',
  '-shortest',
  '-copyts',
  '-hide_banner',
]);

function requireValueAt(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

function hasLaterPositional(args: string[], from: number): boolean {
  for (let i = from; i < args.length; i++) {
    const tok = args[i];
    if (!tok.startsWith('-') || tok === '-') return true;
    if (VALUE_TAKING_FLAGS.has(tok)) i += 1;
  }
  return false;
}

function unknownFlagTakesValue(args: string[], i: number): boolean {
  const next = args[i + 1];
  if (next === undefined || (next.startsWith('-') && next !== '-')) return false;
  return hasLaterPositional(args, i + 2);
}

interface State {
  inv: Invocation;
  pending: string[];
  pendingFormat?: string;
}

function global(state: State, args: string[], i: number): number {
  const tok = args[i];
  const inv = state.inv;
  if (tok === '-y' || tok === '-n') inv.overwrite = tok === '-y' ? 'yes' : 'no';
  else if (tok === '-stats' || tok === '-nostats') inv.stats = tok === '-stats';
  else if (tok === '-v' || tok === '-loglevel') {
    inv.loglevel = requireValueAt(args, i, tok);
    return i + 2;
  } else return -1;
  return i + 1;
}

function option(state: State, args: string[], i: number): number {
  const tok = args[i];
  if (tok === '-i') {
    const path = requireValueAt(args, i, tok);
    state.inv.inputs.push({
      path,
      format: state.pendingFormat,
      raw: [...state.pending, '-i', path],
    });
    state.pending = [];
    state.pendingFormat = undefined;
    return i + 2;
  }
  if (tok === '-f') state.pendingFormat = requireValueAt(args, i, tok);
  if (VALUE_TAKING_FLAGS.has(tok)) {
    state.pending.push(tok, requireValueAt(args, i, tok));
    return i + 2;
  }
  if (!BOOLEAN_FLAGS.has(tok) && unknownFlagTakesValue(args, i)) {
    state.pending.push(tok, args[i + 1]);
    return i + 2;
  }
  state.pending.push(tok);
  return i + 1;
}

function output(state: State, tok: string): void {
  state.inv.outputPath = tok;
  state.inv.outputOpts = state.pending;
  state.inv.outputs += 1;
  state.pending = [];
  state.pendingFormat = undefined;
}

export function parseArgs(args: string[]): Invocation {
  const state: State = {
    inv: {
      inputs: [],
      outputOpts: [],
      outputPath: null,
      outputs: 0,
      overwrite: 'ask',
      stats: true,
      loglevel: 'info',
    },
    pending: [],
  };
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    const next = global(state, args, i);
    if (next >= 0) i = next;
    else if (tok.startsWith('-') && tok !== '-') i = option(state, args, i);
    else {
      output(state, tok);
      i += 1;
    }
  }
  if (state.pending.length > 0 && state.inv.outputPath !== null) {
    state.inv.outputOpts = [...state.inv.outputOpts, ...state.pending];
  }
  return state.inv;
}
