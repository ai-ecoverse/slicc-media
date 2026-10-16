import { attachKernel, createKernel } from '/kernel/index.js';

window.boot = async (files) => {
  const kernel = await createKernel({ metadata: false, ca: false, media: false, users: 'off' });
  const client = await attachKernel(await kernel.connect());
  const manifestsLast = [...files].sort(
    ([, a], [, b]) => Number(a.endsWith('/package.json')) - Number(b.endsWith('/package.json'))
  );
  for (const [url, path] of manifestsLast) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    await client.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/');
    await client.fs.writeFile(path, new Uint8Array(await response.arrayBuffer()));
  }
  window.kernel = kernel;
  return true;
};
