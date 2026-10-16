export interface KernelFile {
  read(position: number, length: number): Promise<Uint8Array>;
  write(position: number, bytes: Uint8Array): Promise<unknown>;
  size(): Promise<number>;
  close(): Promise<unknown>;
}

export interface OpenFlags {
  read?: boolean;
  write?: boolean;
  create?: boolean;
  truncate?: boolean;
}

export interface FdStatus {
  type: string;
  tty: boolean;
  seekable: boolean;
}

export interface Context {
  argv: string[];
  resolve(path: string): string;
  stdin: ReadableStream<Uint8Array>;
  read(fd: number, max?: number): Promise<Uint8Array>;
  write(fd: number, data: Uint8Array | string): Promise<unknown>;
  fdStatus(fd: number): Promise<FdStatus>;
  open(path: string, flags: OpenFlags): Promise<KernelFile>;
  fs: { exists(path: string): Promise<boolean> };
  signals?: { on(signal: string, handler: () => void): unknown };
}

export class UsageError extends Error {}

const ERRNO: Record<string, string> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  EPERM: 'Operation not permitted',
  EROFS: 'Read-only file system',
  ENOSPC: 'No space left on device',
};

export function message(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code in ERRNO) return ERRNO[code];
  return err instanceof Error ? err.message : String(err);
}

export function hasWebCodecs(): boolean {
  return typeof VideoEncoder === 'function' && typeof AudioEncoder === 'function';
}
