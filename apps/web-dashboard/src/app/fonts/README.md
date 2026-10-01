# Dashboard fonts

The dashboard's four font families are vendored here and loaded with `next/font/local` in
[`../layout.tsx`](../layout.tsx), so `next build` makes **no network call** (WARP-3317). The CSS variable names,
`display: "swap"`, weights and `font-family` names are the ones `next/font/google` provided.

**Do not switch back to `next/font/google`.** It downloads the families from fonts.googleapis.com on every build.
On 2026-09-28 it failed the `docker-build` leg of the stage → main promote (PR #2378, run 36499286752) with a
`TypeError` inside its loader (`next/dist/compiled/@next/font/dist/google/loader.js:122`), on code that had built
green earlier that day; with no network it fails outright ("Failed to fetch `Inter` from Google Fonts").
`src/__tests__/fonts-self-hosted.test.ts` fails if the import, or a Google Fonts URL, comes back.

## Files

Each `.woff2` is the **`latin` subset exactly as Google Fonts serves it**, unmodified. They are byte-for-byte
(SHA-256) the preloaded files a `next build` with `next/font/google` emitted on 2026-09-28, when they were fetched.

| File | CSS variable | Axes / style | Font version | Bytes |
|---|---|---|---|---:|
| `inter-latin-wght-normal.woff2` | `--font-inter` | variable, `wght` 100–900, normal | Inter 4.001 | 48 432 |
| `instrument-serif-latin-400-normal.woff2` | `--font-display` | 400, normal | Instrument Serif 1.000 | 15 040 |
| `instrument-serif-latin-400-italic.woff2` | `--font-display` | 400, italic | Instrument Serif 1.000 | 15 684 |
| `space-grotesk-latin-wght-normal.woff2` | `--font-space-grotesk` | variable, file has `wght` 300–700, declared 400–600 | Space Grotesk 2.000 | 22 320 |
| `jetbrains-mono-latin-wght-normal.woff2` | `--font-mono` | variable, `wght` 100–800, normal | JetBrains Mono 2.211 | 40 480 |

```
c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4  inter-latin-wght-normal.woff2
60c06664b5a95c7de6cc3e00d1f9034d78bd1e40b564016b241674449a067d4d  instrument-serif-latin-400-normal.woff2
6ee678c33f388dd7ba59700ebea635deb98821baafd817b09891f7927177f702  instrument-serif-latin-400-italic.woff2
a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557  space-grotesk-latin-wght-normal.woff2
1e06740a02a443fb7f3eeda8fcaa685a0f6c620e3f01e6666e847295469ce3ad  jetbrains-mono-latin-wght-normal.woff2
```

Sources. The CSS URLs are the exact requests `next/font/google` made; the file is the `/* latin */` face in each
response, under `https://fonts.gstatic.com/s/`:

- Inter: `inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2` from
  `https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap`
- Instrument Serif: `instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjnTLgNs.woff2` (normal) and
  `instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjjH7Motmp5g.woff2` (italic) from
  `https://fonts.googleapis.com/css2?family=Instrument+Serif:ital,wght@0,400;1,400&display=swap`
- Space Grotesk: `spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPbF4C_k3HqU.woff2` from
  `https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&display=swap`
  (Google returns this one variable file for all three weights)
- JetBrains Mono: `jetbrainsmono/v24/tDbV2o-flEEny0FZhsfKu5WU4xD7OwGtT0rU.woff2` from
  `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@100..800&display=swap`

## License

All four families are licensed under the **SIL Open Font License 1.1**, which lets them be bundled with software
provided each copy carries the copyright notice and the license text. Each family's upstream `OFL.txt` sits next to
the fonts, taken from `ofl/<family>/OFL.txt` in [google/fonts](https://github.com/google/fonts) at commit
`23e54b51ddffbc7713c583748e3bd86f62b1fa4a`. They are verbatim; only Space Grotesk's CRLF line endings were
normalized to LF.

| License file | Copyright notice | Reserved Font Name |
|---|---|---|
| `OFL-inter.txt` | Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) | none |
| `OFL-instrument-serif.txt` | Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif) | none |
| `OFL-space-grotesk.txt` | Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) | none |
| `OFL-jetbrains-mono.txt` | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | none |

The Inter file's own name table says "Copyright 2016 The Inter Project Authors" where the `OFL.txt` Google distributes
with it says 2020; both are upstream's and neither is edited here. A new family needs its own `OFL-<family>.txt`
before it is committed; the guard test checks that.

## Coverage

Only `latin` (U+0000–00FF plus a few punctuation and currency marks) is vendored. `subsets: ["latin"]` in the old
code only chose what to *preload*: the build also shipped the latin-ext, cyrillic, greek and vietnamese files, which
the browser fetched on demand through `unicode-range`. `next/font/local` has no per-file `unicode-range`, so those
are not vendored. Text outside `latin` (for example ă ș ț ł č, Ω, Ж, ệ) is now drawn by the metric-adjusted fallback
(`Arial`, or `Times New Roman` for Instrument Serif) instead of by these families. If that matters, ship the extra
subsets as plain `@font-face` rules with `unicode-range` in CSS rather than through `next/font/local`.

## Updating

Never re-subset or edit the files. To refresh one, request its CSS URL above with a modern-browser `User-Agent`,
take the woff2 URL of the `/* latin */` face, replace the file, and update the size and SHA-256 here.
