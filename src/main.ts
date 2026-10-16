import type { Context } from './context.ts';
import { runMedia } from './convert/cli.ts';
import { runProbe } from './probe/cli.ts';

export default async function main(ctx: Context): Promise<number> {
  const [, first, ...rest] = ctx.argv;
  if (first === '--probe') return runProbe(ctx, rest);
  return runMedia(ctx, ctx.argv.slice(1));
}
