import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';

const root = resolve(import.meta.dirname, '../..');

function walk(dir, out = []) {
  if (!statSync(dir).isDirectory()) {
    out.push(dir);
    return out;
  }
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

async function install(kernel, name, dir, files) {
  for (const path of files) {
    const rel = relative(dir, path).replaceAll('\\', '/');
    await kernel.writeFile(`/node_modules/${name}/${rel}`, readFileSync(path));
  }
}

export async function boot(options = {}) {
  const kernel = await createNodeKernel(options);
  for (const name of ['@ai-ecoverse/wasm-bash', '@ai-ecoverse/wasm-coreutils']) {
    const dir = join(root, 'node_modules', name);
    await install(kernel, name, dir, walk(dir));
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const own = [join(root, 'package.json'), ...pkg.files.flatMap((f) => walk(join(root, f)))];
  await install(kernel, pkg.name, root, own);
  const fixtures = join(root, 'test/integration/fixtures');
  for (const name of readdirSync(fixtures)) {
    await kernel.writeFile(`/tmp/${name}`, readFileSync(join(fixtures, name)));
  }
  return {
    kernel,
    sh: (script, opts = {}) => kernel.run(['sh', '-c', script], { cwd: '/tmp', ...opts }),
    close: () => kernel.terminate(),
  };
}
