[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Khamami13/sitegen-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Khamami13/sitegen-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# SiteGen Fast

A faster drop-in for makefun-site 1.0.0 — a static site generator that turns Markdown sources (front matter, its own template dialect, its own Markdown subset, slug rules and build report) into an output tree of HTML pages, index/tag pages, `build-report.txt` and static files. `solve.js` returns byte-identical answers to makefun-site 1.0.0 on every case, but runs several times faster.

## How it is faster

- **Fused single-pass Markdown**: lexing and rendering are one pass over the lines, with first-character dispatch instead of a regex per line per block type.
- **Regex-jump inline scanner**: the inline renderer jumps straight to the next special character with one native regex search instead of a per-character loop with a regex escape per character.
- **Cached slugs and link resolutions**: tag/title/heading slugs and relative-link targets are resolved once per build.
- **Scanning front matter**: front matter is parsed by scanning line boundaries instead of splitting the whole file.
- **Array-joined template rendering**: templates render into an array joined once, with pre-split paths and numeric node kinds; nothing is cached from one case to the next (all state lives inside `run()`).

## How to run

Requires Node 22. The harness driver `main.ts` reads every case from the input directory and writes the answers:

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`main.ts` reads `<input>/cases.json` (an array of `{id, input}`), answers each case alone with `run()` from `solve.js`, and writes `<output>/answers.json`. Without the environment variables it uses `/input` and `/output`, as in the competition sandbox.

## Practice benchmark

Practice set from the competition kit (3 cases), timed with the same driver, interleaved runs, 9 repetitions each, median per case:

| Case | Files | makefun-site 1.0.0 | SiteGen Fast | Speedup |
| --- | --- | --- | --- | --- |
| g-0001 | 257 | 112.5 ms | 29.9 ms | 3.76× |
| g-0002 | 348 | 185.5 ms | 66.2 ms | 2.80× |
| g-0003 | 486 | 231.9 ms | 60.7 ms | 3.82× |
| **Total** | | **529.9 ms** | **156.8 ms** | **3.38×** |

Correctness on the practice set: **3/3 cases byte-identical** to `practice/reference/expected.json`, and two executions of the entry produce byte-identical output.

<sub>Entered on [make.fun](https://make.fun/?ref=kwb58z1j&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
