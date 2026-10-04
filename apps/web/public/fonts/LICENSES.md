# Self-hosted webfonts

Downloaded and subset by `pnpm ui:fetch-fonts`
(`packages/ui/scripts/fetch-fonts.mjs`). Do not add files here by hand — the
script emits `packages/ui/src/fonts.generated.css` to match, and a file without
a matching `@font-face` is dead weight on a 256 kbps connection.

| Family | Files | Licence |
|---|---|---|
| Noto Sans | `noto-sans-latin*.woff2`, `noto-sans-currency-*.woff2` | SIL Open Font License 1.1 |
| Noto Sans Arabic | `noto-sans-arabic-arabic-*.woff2` | SIL Open Font License 1.1 |
| JetBrains Mono | `jetbrains-mono-latin*.woff2` | SIL Open Font License 1.1 |
| Material Symbols Rounded | `material-symbols-rounded-subset.woff2` | Apache License 2.0 |

All four are redistributable, which is what makes self-hosting possible.

## Why these are committed

Kasuwa's users are on African mobile networks and the NFRs commit to a
workspace usable at 256 kbps (PRD 2.13). A third-party font host adds a DNS
lookup, a TLS handshake and an origin that can be slow or blocked — on the
connections that matter most, that is the difference between text appearing and
a blank screen. It also sends the user's IP to a third party on every page
load, which is an NDPA question we do not need to have.

**Self-hosted only (D-L43).** Each `src` names one file under `/fonts/` and
nothing else. A Google Fonts fallback used to sit second in every list, which
meant a failed local file sent the user's IP to Google anyway. If a local file
404s after a bad deploy, text renders in the fallback stack until the deploy is
fixed; `packages/ui/src/fonts.test.ts` fails on any external origin.

## Weight, and why `unicode-range` matters

| File | Size |
|---|---|
| `noto-sans-latin-400800.woff2` | ~34 KB |
| `jetbrains-mono-latin-400600.woff2` | ~30 KB |
| `material-symbols-rounded-subset.woff2` | ~8 KB |
| `jetbrains-mono-latin-ext-400600.woff2` | ~11 KB |
| `noto-sans-currency-400800.woff2` | ~3 KB |
| `noto-sans-latin-ext-400800.woff2` | ~164 KB |
| `noto-sans-arabic-arabic-400700.woff2` | ~162 KB |

The critical path is about **74 KB** — Latin, mono and icons. The two large
files carry Latin Extended (the Yoruba, Igbo and Hausa diacritics: ẹ ọ ṣ ɓ ɗ ƙ)
and Arabic, and each `@font-face` declares a `unicode-range`, so a browser only
downloads them when the page actually contains those characters. Removing the
`unicode-range` declarations would push every Lagos agent to ~370 KB of fonts
on first load.

**The naira and cedi signs (₦ U+20A6, ₵ U+20B5) have their own ~3 KB face
(D-L44).** Both sit inside Latin Extended's range, so one `₦` on a screen used
to download all 164 KB of it. They are now cut out of the Latin-Extended
`unicode-range` and served from `noto-sans-currency-400800.woff2`, listed ahead
of it.

The icon font is subset to the ~69 symbols the design uses
(`packages/ui/icon-subset.txt`). Whole, Material Symbols Rounded is several
megabytes. **Adding an icon to a screen means adding its name to that file and
re-running `pnpm ui:fetch-fonts`** — otherwise it renders as a blank box.
