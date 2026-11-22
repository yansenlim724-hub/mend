# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yansenlim724-hub/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yansenlim724-hub/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every edit format a model writes. `mend` reads a unified
diff, SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool calls
as JSON, and applies the edit to a tree of text files — every file, or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-` (or nothing) to read the patch from standard
input. Options:

- `--format=NAME` — `auto` (the default), `unified`, `search-replace`,
  `v4a` or `json`. With `auto` the format is detected from the patch text.
- `--check` — do everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` — match lines exactly, no whitespace-tolerant tiers.

## What it does

Models drift: a unified diff with wrong line numbers, a search block whose
indentation does not match the file, a patch written against a CRLF file.
`mend` finds the lines an edit names anyway, at the first of three matching
tiers where they occur:

- tier 0 — every line equal;
- tier 1 — equal once trailing spaces and tabs are removed;
- tier 2 — equal once leading and trailing spaces and tabs are removed
  (added lines are re-indented to the file's indentation).

Each format then picks its occurrence the way its section of the spec says:
a unified hunk takes the occurrence nearest its (possibly wrong) line
number, a SEARCH/REPLACE block needs exactly one, a V4A chunk follows its
anchor and cursor. A file's own line breaks (LF or CRLF) and its final line
break are kept, context lines are written back as the file has them, and a
move is reported as one `R old -> new` line. Edits apply in patch order to
the tree as earlier edits left it; a failed edit changes nothing, the edits
after it still run, and when any edit failed no file is written at all.

## Exit codes and output

- `0` — the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R old -> new`), then `ok: <n> files`.
- `1` — one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. Codes: `no-match`, `ambiguous`, `missing`,
  `exists`, `unsafe`.
- `2` — one line only: `error: usage`, `error: no-patch`, `error: format`,
  or `error: parse <N>`.

Node 22 and its standard library only; nothing is installed before the
program runs. `runner.ts` is the trial harness the kit ships: keep it as it
is.
