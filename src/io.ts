import {
  AppendOnlyStreamTarget,
  CustomSource,
  ReadableStreamSource,
  type Source,
  StreamTarget,
  type StreamTargetChunk,
  type Target,
} from 'mediabunny';
import type { Context, KernelFile } from './context.ts';

export const STDIN_NAMES = new Set(['-', 'pipe:', 'pipe:0', '/dev/stdin']);
export const STDOUT_NAMES = new Set(['-', 'pipe:', 'pipe:1', '/dev/stdout']);

export interface OpenedSource {
  source: Source;
  size: number | null;
  close(): Promise<void>;
}

export interface OpenedTarget {
  target: Target;
  error(): unknown;
  close(): Promise<void>;
}

const ignore = (): void => {};

function fileSource(file: KernelFile, size: number): OpenedSource {
  const source = new CustomSource({
    getSize: () => size,
    read: (start, end) => file.read(start, end - start),
    prefetchProfile: 'fileSystem',
    handleUnhandledError: ignore,
  });
  return {
    source,
    size,
    close: async () => {
      await file.close();
    },
  };
}

export async function openSource(ctx: Context, name: string): Promise<OpenedSource> {
  if (STDIN_NAMES.has(name)) {
    const status = await ctx.fdStatus(0);
    if (status.type === 'file') {
      const file = await ctx.open('/dev/stdin', { read: true });
      return fileSource(file, await file.size());
    }
    return {
      source: new ReadableStreamSource(ctx.stdin, {
        maxCacheSize: 256 * 1024 * 1024,
        handleUnhandledError: ignore,
      }),
      size: null,
      close: async () => {},
    };
  }
  const file = await ctx.open(ctx.resolve(name), { read: true });
  return fileSource(file, await file.size());
}

function guarded<T>(write: (chunk: T) => Promise<unknown>, onError: () => void) {
  let failure: unknown;
  const writable = new WritableStream<T>({
    write: async (chunk) => {
      if (failure !== undefined) return;
      try {
        await write(chunk);
      } catch (err) {
        failure = err;
        onError();
      }
    },
  });
  return { writable, error: () => failure };
}

function positional(file: KernelFile, onError: () => void): OpenedTarget {
  const { writable, error } = guarded<StreamTargetChunk>(
    (chunk) => file.write(chunk.position, chunk.data),
    onError
  );
  return {
    target: new StreamTarget(writable),
    error,
    close: async () => {
      await file.close();
    },
  };
}

export async function openTarget(
  ctx: Context,
  name: string,
  onError: () => void
): Promise<OpenedTarget> {
  if (STDOUT_NAMES.has(name)) {
    const status = await ctx.fdStatus(1);
    if (status.type === 'file') {
      return positional(await ctx.open('/dev/stdout', { write: true }), onError);
    }
    const { writable, error } = guarded<Uint8Array>((chunk) => ctx.write(1, chunk), onError);
    return { target: new AppendOnlyStreamTarget(writable), error, close: async () => {} };
  }
  const flags = { write: true, create: true, truncate: true };
  return positional(await ctx.open(ctx.resolve(name), flags), onError);
}
