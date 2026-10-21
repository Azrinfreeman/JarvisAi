# Ambience recording provenance

## Sunny morning birdsong

The sunny recording is [“MORNING BIRDS CATALUNYA” by Juno24](https://freesound.org/people/Juno24/sounds/845257/), published under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The creator describes a stereo forest recording of morning birds, with brief insects. `sunny-birds-source.mp3` is Freesound's public high-quality MP3 preview, rather than the lossless original.

`sunny-birds-loop.pcm` uses seconds 3–123, filtered below 80 Hz and above 12 kHz, with a two-second loop crossfade and gentle peak shaping. The resulting 118-second source loop is 48 kHz stereo signed 16-bit PCM, with a measured average near -31.4 dBFS and peak near -12 dBFS before playback processing. No rain or thunder is layered into sunny mode. The recording is bundled locally; nothing is downloaded during playback.

Sunny playback now takes random 5–9 second excerpts at 40% of the earlier birdsong signal level, with smooth 1.5-second fades and random 25–55 second gaps. A two-stage 350 Hz low-pass version of the same recording, reduced to 12% signal level, supplies the quiet background between excerpts. This suppresses most bird frequencies; it is a filtered part of the field recording rather than a separate wind recording. The shared `RAIN_VOLUME` setting (default 0.5) then scales both layers. `npm run preview-sunny` creates a two-minute WAV using the normal timing, so each preview is different.

## Forest rain

The bundled recording is **“ForestRainShower1a.mp3” by AlanCat**, a stereo field recording of light rain in a forest and drops on understory leaves. The creator uploaded it to [Freesound](https://freesound.org/people/AlanCat/sounds/383064/) under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The local `rain-source.mp3` is the public MP3 served as `leaves.mp3` by [Rain Sounds for Sleeping](https://rainsoundsforsleeping.com/licensing/), which identifies the same Freesound source. No audio is fetched during bot operation.

The bundled `rain-loop.pcm` uses seconds 3–63 of that field recording. The build script removes low rumble below 80 Hz and excessive high hiss above 12 kHz, crossfades the last two seconds into the opening, gently raises the average level, and caps isolated drops at about −12 dBFS. The resulting 58-second loop is 48 kHz stereo, signed 16-bit PCM. Discord voice encodes the local PCM stream to Opus.

To rebuild it, install FFmpeg separately and run `node scripts/build-rain-loop.js`. Set `FFMPEG_PATH` if FFmpeg is not on `PATH`. FFmpeg is needed only to rebuild the asset, not to run the bot. Run `npm run preview-rain` to write a 30-second WAV preview.

## Additional scenes

Each additional recording was published on Freesound under CC0 1.0. The bundled source files are Freesound's public high-quality MP3 previews, and the PCM files were prepared locally from them. No recording is fetched while the bot runs.

| Scene | Recording | Source file | Processed loop |
| --- | --- | --- | --- |
| Soft | [“Light Rain” by soundrecorder7](https://freesound.org/people/soundrecorder7/sounds/167034/) | `rain-soft-source.mp3` | `rain-soft-loop.pcm` |
| Indoor | [“Rain on roof (interior perspective)” by xkeril](https://freesound.org/people/xkeril/sounds/610543/) | `rain-indoor-source.mp3` | `rain-indoor-loop.pcm` |
| Glass | [“RAIN on glass window.wav” by nicoproson](https://freesound.org/people/nicoproson/sounds/648529/) | `rain-glass-source.mp3` | `rain-glass-loop.pcm` |
| Heavy | [“Heavy Rain Sound - Inu Etc.mp3” by inuetc](https://freesound.org/people/inuetc/sounds/507902/) | `rain-heavy-source.mp3` | `rain-heavy-loop.pcm` |

The additional loops use the same high-pass/low-pass filtering, crossfade, average-level target, and peak shaping as the forest loop. Their processed lengths are approximately 23, 98, 98, and 51 seconds respectively. Source previews may have different fidelity than the original Freesound downloads. `npm run preview-variety` writes a short listening sample with all scene types; the normal bot changes scenes much more slowly.

## Distant thunder

All four thunder recordings were published under CC0 1.0. The bundled source MP3 files are Freesound's public high-quality previews. Each corresponding PCM file contains 48 kHz stereo audio with a two-second fade in, three-second fade out, and a peak ceiling near -16 dBFS before the quieter runtime mix.

| Asset prefix | Recording | Trim start | Duration |
| --- | --- | --- | --- |
| `thunder-distant-a` | [“thunder.rumble.ogg” by xUMR](https://freesound.org/people/xUMR/sounds/486557/) | 0 s | 20 s |
| `thunder-distant-b` | [“THUN_RGleeson_Weather dry thunder distant_STE004” by roisin.gleeson](https://freesound.org/people/roisin.gleeson/sounds/844680/) | 2 s | 34 s |
| `thunder-distant-c` | [“DistantThunder.wav” by Kragnour](https://freesound.org/people/Kragnour/sounds/473864/) | 1 s | 32 s |
| `thunder-distant-d` | [“Distant Thunder 1” by Fission9](https://freesound.org/people/Fission9/sounds/581122/) | 0 s | 34 s |

For each prefix, `<prefix>-source.mp3` is the source and `<prefix>.pcm` is the processed file. The build script filters low noise and high hiss, shapes peaks, and fades the beginning and end. Use `node scripts/build-thunder.js <source> <output> <duration-seconds> <start-seconds>` with FFmpeg installed to rebuild one. Thunder is mixed quietly into Variety and Mild thunder rain and never fetched during bot operation. Fission9 describes the source as intended for low-volume playback; these previews are not lossless originals.
