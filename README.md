# slicc-media

Media commands for SLICC: `media` converts and `mediaprobe` inspects audio and video files, with ffmpeg's and ffprobe's command-line syntax. They run as slicc-kernel JS programs (`"abi": "js"`), each in a process worker of its own, where the browser's **WebCodecs** does every decode and encode. The package ships **no codecs**: what can be decoded or encoded is whatever the browser offers. Containers are read and written by [mediabunny](https://github.com/Vanilagy/mediabunny).

**This is not FFmpeg.** It contains no FFmpeg code, and the commands have their own names. They take the ffmpeg options agents already know, refuse by name every option they can't honour, and never quietly produce a different file than the one asked for.

## Install

```sh
pnpm add -g @ai-ecoverse/slicc-media
```

It needs slicc-kernel 1.102.0 or later (`engines.slicc-kernel`). Both commands are in one module, `dist/media.mjs`; `mediaprobe` is `media --probe`.

## `mediaprobe`

```sh
mediaprobe clip.mp4
mediaprobe -v error -show_format -show_streams -of json clip.webm
mediaprobe -show_entries stream=codec_name,channels -select_streams a:0 -of csv=p=0 talk.m4a
cat clip.webm | mediaprobe -of json -show_format -
```

It reads the container's index and decodes nothing, so it works on every container mediabunny reads (mp4/mov, webm/mkv, mp3, wav, ogg, flac, aac, mpegts), whether or not this browser can decode the codec, and in the Node entry too.
- **Options:** `-i FILE` or a bare `FILE` (`-` or `pipe:0` reads stdin), `-show_format`, `-show_streams`, `-show_entries format=a,b:stream=c,d`, `-select_streams v|a|v:N|a:N`, `-count_packets`, `-of`/`-print_format json|csv[=p=0]|default[=nw=1:nk=1]`, `-v`/`-loglevel` (`quiet` silences errors), `-hide_banner`.
- **Fields:** format `filename`, `nb_streams`, `format_name`, `duration`, `start_time`, `size`, `bit_rate`; streams `index`, `codec_type`, `codec_name`, `width`, `height`, `r_frame_rate`, `avg_frame_rate`, `sample_rate`, `channels`, `channel_layout`, `bit_rate`, `duration`, `nb_read_packets`. Names and formats are ffprobe's (`h264`, `pcm_s16le`, `matroska,webm`, six-decimal seconds). A field the container doesn't give is left out, never guessed.
- Without `-show_*` or `-of`, it prints a short human summary.
- An unknown option, or a file that isn't media, exits 1 with the reason on stderr.

## `media`

```sh
media -i clip.webm -c:v libvpx -c:a libopus out.webm
media -i in.mp4 -vf scale=640:-2,fps=15 -c:v libvpx-vp9 -b:v 800k small.webm
media -ss 5 -t 10 -i talk.mp4 -c copy part.mp4
media -i talk.mp4 -vn -c:a pcm_s16le -ar 16000 -ac 1 talk.wav
media -i clip.mp4 -c copy -f mpegts - | mediaprobe -
```

One input and one output; the input can also be [the screen or a microphone](#capture). The options:

|                   |                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| input and output  | `-i FILE` (`-` or `pipe:0` is stdin), `OUTPUT` (`-` or `pipe:1` is stdout, with `-f`), `-f FMT` for the output container (otherwise the extension), `-y`, `-n`                                                                                              |
| codecs            | `-c copy`, `-c:v`/`-vcodec` `libx264`/`h264`, `libx265`/`hevc`, `libvpx`/`vp8`, `libvpx-vp9`/`vp9`, `libaom-av1`/`libsvtav1`/`av1`, `copy`; `-c:a`/`-acodec` `aac`, `libopus`, `libmp3lame`, `libvorbis`, `flac`, `pcm_s16le` and the other `pcm_*`, `copy` |
| rates and quality | `-b:v`, `-b:a`, `-crf` and `-q:a` (mapped to mediabunny's five quality presets: approximate), `-g` with `-r`                                                                                                                                                |
| trim              | `-ss`, `-t`, `-to` before or after `-i`. With `-c copy`, the cut starts at the key frame before `-ss`, as in FFmpeg                                                                                                                                         |
| video             | `-vf` with `scale=W:H` (`-1`/`-2` keep the aspect ratio), `crop=w:h:x:y`, `transpose=1\|2`, `fps=N`, `format=yuv420p`, chained in that order; `-s WxH`, `-r FPS`, `-vn`                                                                                     |
| audio             | `-af aresample=RATE`, `-ar`, `-ac`, `-an`                                                                                                                                                                                                                   |
| other             | `-metadata title=…` (and `artist`, `album`, `album_artist`, `genre`, `comment`, `description`), `-movflags faststart` or `frag_keyframe`, `-map 0`, `-nostats`, `-v quiet\|error`                                                                           |
| info              | `-version`, `-h`, `-formats`, `-encoders` and `-decoders` (asked of the browser each time)                                                                                                                                                                  |
- **Codecs:** every encode and decode is the browser's. Chromium has VP8, VP9, AV1 and Opus encoders everywhere; H.264, HEVC and AAC depend on the build and the platform; MP3, Vorbis and FLAC encoders are usually missing. There is no fallback: when the browser lacks one, `media` names the stream and the codec and exits 1, for example `media: video stream #0:0: no decoder for 'h264' (this browser has none)`. `media -encoders` lists what this browser can encode.
- **Without WebCodecs** (the kernel's Node entry), probing, stream copy and PCM audio work, and anything that needs a decoder or an encoder fails with a message that says so.
- **Stream copy:** `-c copy` copies or fails, it never re-encodes; a codec the output container can't hold is an error (`'h264' cannot be stream-copied into webm here`).
- **Pipes:** stdout takes webm, mkv, mp4 and mov (written fragmented), mpegts, ogg, adts and mp3. stdin is read as a stream; an input whose index sits at its end (an mp4 written without faststart) is buffered up to 256 MiB.
- **Files** are read and written in place through the kernel's paged files, so neither the input nor the output is held in memory.
- **Overwrite:** an existing output needs `-y`; on a terminal `media` asks, otherwise it exits 1.
- **Progress** goes to stderr (`time=00:00:01.20 progress=40%`), one updating line on a terminal, every 10% otherwise; `-nostats` turns it off.
- **The output** is opened (and an existing one truncated) only when the first bytes for it are ready, so an input that fails before that leaves no file, and an existing output stays as it was.
- **^C** (SIGINT) or SIGTERM cancels: `Exiting normally, received signal 2.` and status 255, as FFmpeg does, but the partial output isn't finalized (a [capture](#capture) is).
- **Not supported**, each refused by name: more than one input or output, `-filter_complex` and every filter not listed above, `-map` other than `0`, `-shortest`, `-pix_fmt` other than `yuv420p`, `-f lavfi` test sources, frame or image output from a file, two-pass, lossless video, and the [capture](#capture) devices not listed there.

## Capture

```sh
media -f avfoundation -list_devices true -i ""
media -f avfoundation -i "Capture screen 0" -t 10 -c:v libx264 out.mp4
media -f avfoundation -capture_cursor 1 -i 0 screen.webm
media -f x11grab -i :0.0 -t 5 -c copy screen.mkv
media -f gdigrab -i desktop -frames:v 1 shot.png
media -f avfoundation -i ":0" -t 5 -c:a pcm_s16le talk.wav
media -f pulse -i default -ar 16000 -ac 1 note.wav
media -f alsa -i "USB Mic" -t 60 -c:a copy talk.webm
```

### The screen

`media` records the screen by asking seven's page, as a `capture.screen` request on the kernel's [`/dev/embedder`](https://github.com/ai-ecoverse/slicc-kernel#devembedder): the page module of [slicc-capture](https://github.com/ai-ecoverse/slicc-capture), with slicc-bios's prompt and guards in front. The user picks the screen, a window or a tab in Chrome's picker; nothing here can skip it. The page records with `MediaRecorder` (WebM, VP9 or VP8, with Opus when there is audio) and sends a chunk every 250 ms, which `media` reads as it arrives and remuxes, or with `-c:v`, `-vf` or `-r` transcodes, into the output, as for any other input.
- **Devices:** `-f avfoundation` lists, as on macOS, the cameras and then `Capture screen 0` as video devices, and the microphones as audio devices. There are no cameras yet, so the screen is `-i 0` or `-i "Capture screen 0"` (in any case). `-list_devices true` prints the list on stderr, in avfoundation's lines, and exits 0:
  ```
  [AVFoundation indev @ 0x0] AVFoundation video devices:
  [AVFoundation indev @ 0x0] [0] Capture screen 0
  [AVFoundation indev @ 0x0] AVFoundation audio devices:
  [AVFoundation indev @ 0x0] [0] Default - MacBook Pro Microphone
  [AVFoundation indev @ 0x0] [1] USB Mic
  ```
  The microphones come from the page (an `audio.record` request with `devices: true`); the browser gives their labels only once seven may use the microphone, and a microphone without one is listed as `Microphone N`. Where no page answers, the list has the screen and no microphones; where the page refuses to list them (a denial, for example), `media` prints the screen entry, then `media: <message>`, and exits 1.
- **Aliases:** `-f x11grab -i <anything>` and `-f gdigrab -i desktop` are the screen; `-f gdigrab -i title=<name>` starts the picker at windows, and the user still picks one.
- **Options:** `-t` (or `-to`) stops the recording after that long and trims to it; `-ss` trims the start. `-capture_cursor 1` asks for the cursor, `0` for none. `-framerate` is accepted, but the browser decides the rate, which varies; `-r` or `-vf fps=` make it constant. `-pixel_format`, `-probesize`, `-thread_queue_size` and `-rtbufsize` are accepted and change nothing. Refused by name: `-video_size` (scale with `-vf scale`), x11grab offsets `+x,y` (crop with `-vf crop`), `-draw_mouse` and `-capture_mouse_clicks`.
- **Stills:** `-frames:v 1`, `-update 1` or an image output (`.png`, `.jpg`, `.jpeg`, `.webp`) ask the page for one frame in that format, and `media` writes its bytes unchanged. A filter, a codec or a trim on a still is refused by name, as is another frame count.
- **Stopping:** without `-t`, a recording runs until `q` on a terminal's stdin (not with `-nostdin`), ^C, `SIGTERM` or `SIGHUP`, or until the user clicks Chrome's **Stop sharing**. Each of them closes the request and finalizes the output, so the file plays; the last quarter second may be lost. After a signal `media` prints `Exiting normally, received signal N.` and exits 255; after `q` or Stop sharing it exits 0.
- **Progress:** a capture has no known length, so there is no `time=` line. The page's own lines reach stderr as `media: <line>`, such as `media: recording…`.
- **Errors**, each with exit 1: `media: user cancelled, permission denied, or the surface is protected` for a refused prompt, a closed picker or a protected surface; `media: capture needs seven's page (no page answers capture.screen)` in the kernel's Node entry, or in a shell whose page doesn't answer it; any other error from the page as `media: <message>`.
- **Not supported yet:** cameras, so `-f avfoundation -i 1`, a spec with both a video and an audio part (`"0:0"`), `-f v4l2` and `-f dshow` are each refused as `media: -f <format> -i "<spec>": not supported yet`.

### A microphone

`media` records a microphone by asking seven's page for an `audio.record` request without the speech gate (`{"kind":"audio.record","gate":false,"device":…,"seconds":…}`): the page module of [slicc-audio](https://github.com/ai-ecoverse/slicc-audio), with slicc-bios's consent, Microphone switch and recording indicator in front. The page sends WebM Opus from the first chunk, silence included, every 250 ms, and `media` reads it as it arrives, as it does the screen.
- **Devices:** `-f avfoundation -i ":A"` (or `"none:A"`) records the microphone `A`: an index into the list above, a name from it (in any case), or `default`. `-f pulse -i default|N|NAME` and `-f alsa -i default|N|NAME` are the same. `default`, or no name, is the browser's default microphone, asked for without a device; any other spec makes `media` list the microphones first, and one that isn't there is `media: no such audio device: <spec>`.
- **Output:** any audio container `media` writes: `wav`, `ogg`, `webm`, `mkv`, `m4a` (`-c:a aac`, where the browser encodes AAC), `mp3` only where the browser has an MP3 encoder. `-c:a copy` keeps the page's Opus into webm, mkv or ogg without re-encoding; `-ar`, `-ac` and `-af aresample=RATE` work after `-i`, as for files.
- **Options:** `-t` (or `-to`) asks the page for that many seconds (`seconds`) and trims to it; `-ss` trims the start. Video options (`-framerate`, `-video_size`, `-capture_cursor`) are refused for a microphone by name, as are filters and frame counts.
- **Stopping:** as for the screen: `-t`, `q` on a terminal's stdin, ^C, `SIGTERM` or `SIGHUP`, or Stop in seven's recording indicator. Each finalizes the file; a signal exits 255, the rest 0.
- **Errors**, each with exit 1 and no output file left behind: the page's own refusal as `media: <message>` (`media: microphone capture is off in seven's settings`, a denial, `media: nobody clicked within 5 min`); `media: the page sent no audio` when the recording ends empty; `media: capture needs seven's page (no page answers audio.record)` without a page. When the page fails partway, `media` removes the output it had started.

## Licences

The package is Apache-2.0. `dist/media.mjs` bundles mediabunny, unmodified, at the exact version `package.json` pins, which is MPL-2.0: its licence is `dist/mediabunny-LICENSE`, the version is on the bundle's first line and in `media -version`, and its source is at [github.com/Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny) (that version's release tag) and in the [mediabunny npm package](https://www.npmjs.com/package/mediabunny). None of mediabunny's codec extension packages are included. The test fixtures in `test/integration/fixtures/` are a few KB of generated media.

The argv handling, the plan translation and the probe output are ported from SLICC 6's `ffmpeg` and `ffprobe` commands (Apache-2.0), without their ffmpeg.wasm engine.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm run build` bundles `src/` into `dist/media.mjs` with esbuild.
- `npm run lint`: Biome, `tsc`, and the [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks (no comments, no unit tests in git, AGENTS.md).
- `npm test` builds, then runs `test/integration/`: the commands on the kernel's Node entry (`media.test.mjs`), and in Chromium with WebCodecs through the shared-web harness (`browser.test.mjs`). The harness finds a Chrome through `@ai-ecoverse/slicc-cdp` (a system Chrome, or one `npx slicc-cdp install-browser` installed) unless `CHROME_PATH` names one. It runs headless locally and headed when `CI` is set, each Chrome on an Xvfb display of its own on Linux.
- `npm run test:unit` runs the gitignored `test/unit/` with coverage; the pre-commit hook wants 100% of changed lines covered.
- CI is `.github/workflows/ci.yml`, the only workflow: it calls slicc-shared-web's [pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline), pinned to the same version as the `@ai-ecoverse/slicc-shared-web` devDependency. Pull requests and the merge queue run `npm run lint`, then `npm test` split over 2 shards on Chrome for Testing; pull requests also get a Claude and a Codex review. The checks to require are `ci / integration` and `ci / review`.
- Releases: every push to `main` runs semantic-release from `ci.yml` (`.releaserc.json`), which tags, writes the GitHub release and publishes to npm through trusted publishing with provenance. `fix`, `feat` and `perf` commits release; the rest don't.
