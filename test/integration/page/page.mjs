import { attachKernel, createKernel } from '/kernel/index.js';

const live = new Set();

window.capture = { refuse: null, requests: [], live };

function fakeMedia() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const g = canvas.getContext('2d', { alpha: false });
  let frame = 0;
  const draw = () => {
    frame += 1;
    g.fillStyle = `hsl(${(frame * 7) % 360} 80% 50%)`;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#fff';
    g.fillRect((frame * 4) % canvas.width, 100, 40, 40);
  };
  draw();
  const timer = setInterval(draw, 33);
  const video = canvas.captureStream(30);
  const audio = new AudioContext();
  const tone = audio.createOscillator();
  const sink = audio.createMediaStreamDestination();
  tone.connect(sink);
  tone.start();
  const stream = new MediaStream([...video.getVideoTracks(), ...sink.stream.getAudioTracks()]);
  const stop = () => {
    clearInterval(timer);
    for (const track of stream.getTracks()) track.stop();
    tone.stop();
    void audio.close();
  };
  return { stream, stop };
}

function recording(options, signal) {
  const media = fakeMedia();
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm;codecs=vp8,opus';
  const recorder = new MediaRecorder(media.stream, { mimeType });
  let chain = Promise.resolve();
  let done = false;
  let timer;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    live.delete(handle);
    if (recorder.state !== 'inactive') recorder.stop();
    else media.stop();
  };
  const handle = { end: finish };
  return new ReadableStream({
    start(controller) {
      recorder.ondataavailable = (event) => {
        chain = chain.then(async () => {
          if (event.data.size === 0) return;
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          try {
            controller.enqueue(bytes);
          } catch {}
        });
      };
      recorder.onstop = () => {
        media.stop();
        chain = chain.then(() => {
          try {
            controller.close();
          } catch {}
        });
      };
      signal.addEventListener('abort', finish, { once: true });
      recorder.start(250);
      live.add(handle);
      if (options.duration !== undefined) timer = setTimeout(finish, options.duration * 1000);
    },
    cancel: finish,
  });
}

async function still(type) {
  const canvas = new OffscreenCanvas(320, 240);
  const g = canvas.getContext('2d');
  g.fillStyle = '#36c';
  g.fillRect(0, 0, 320, 240);
  const blob = await canvas.convertToBlob({ type, quality: 0.9 });
  return new Uint8Array(await blob.arrayBuffer());
}

const requests = {
  kinds: { 'capture.screen': {} },
  async handle({ options, signal, progress }) {
    window.capture.requests.push(options);
    if (window.capture.refuse) throw new DOMException(window.capture.refuse, 'NotAllowedError');
    const type = options.type ?? 'image/png';
    if (type.startsWith('image/')) return still(type);
    progress('recording…');
    return recording(options, signal);
  },
};

window.boot = async (files) => {
  const kernel = await createKernel({
    metadata: false,
    ca: false,
    media: false,
    users: 'off',
    requests,
  });
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
