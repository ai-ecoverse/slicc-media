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

One input and one output. The options:

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
- **^C** (SIGINT) or SIGTERM cancels: `Exiting normally, received signal 2.` and status 255, as FFmpeg does, but the partial output isn't finalized.
- **Not supported**, each refused by name: more than one input or output, `-filter_complex` and every filter not listed above, `-map` other than `0`, `-shortest`, `-pix_fmt` other than `yuv420p`, `-f lavfi` test sources, frame or image output, capture devices, two-pass, lossless video.

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
