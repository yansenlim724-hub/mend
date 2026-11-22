// mend: one patch tool for every AI edit format, as SPEC.md specifies.
// It reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON
// text-editor tool calls, finds the lines an edit names even when the model
// drifted their whitespace or indentation (three matching tiers), and changes
// every file or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** new path -> original path for files moved by a move edit (chained). */
  readonly moves = new Map<string, string>();
  move(oldP: string, newP: string, text: string): void {
    const orig = this.moves.get(oldP) ?? oldP;
    this.moves.delete(oldP);
    this.now.set(oldP, null);
    this.now.set(newP, text);
    this.moves.set(newP, orig);
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- shared helpers for the line-based formats (SPEC.md sections 3 and 5) ----

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchAt(lines: string[], at: number, o: string[], tier: number): boolean {
  for (let j = 0; j < o.length; j++) {
    if (normLine(lines[at + j]!, tier) !== normLine(o[j]!, tier)) return false;
  }
  return true;
}

function occFrom(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    if (matchAt(lines, i, o, tier)) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occFrom(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Build the replacement lines for a matched occurrence.
 * Context lines are written as the file's own matched lines; other lines of
 * N are re-indented at tier 2 (SPEC.md section 5).
 */
function buildReplacement(
  fileLines: string[],
  at: number,
  o: string[],
  n: string[],
  oCtx: boolean[],
  nCtx: boolean[],
  tier: number,
): string[] {
  const out: string[] = [];
  let oi = 0;
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadWs(o[0]!);
    f = leadWs(fileLines[at]!);
  }
  for (let j = 0; j < n.length; j++) {
    if (nCtx[j]) {
      while (oi < o.length && !oCtx[oi]) oi += 1;
      out.push(fileLines[at + oi]!);
      oi += 1;
    } else {
      const line = n[j]!;
      if (tier === 2 && o.length > 0 && line !== '' && line.trim() !== '' && line.startsWith(p)) {
        out.push(f + line.slice(p.length));
      } else {
        out.push(line);
      }
    }
  }
  return out;
}

function perr(n: number): never {
  throw new Exit2(`error: parse ${n}`);
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Split a hunk/chunk body into old lines O, new lines N and context flags. */
function splitON(
  body: { type: 'ctx' | 'old' | 'new'; text: string }[],
): { o: string[]; n: string[]; oCtx: boolean[]; nCtx: boolean[] } {
  const o: string[] = [];
  const n: string[] = [];
  const oCtx: boolean[] = [];
  const nCtx: boolean[] = [];
  for (const e of body) {
    if (e.type === 'ctx') {
      o.push(e.text);
      n.push(e.text);
      oCtx.push(true);
      nCtx.push(true);
    } else if (e.type === 'old') {
      o.push(e.text);
      oCtx.push(false);
    } else {
      n.push(e.text);
      nCtx.push(false);
    }
  }
  return { o, n, oCtx, nCtx };
}

// ---- unified diffs (SPEC.md section 6) ----

interface UEntry {
  type: 'ctx' | 'old' | 'new';
  text: string;
  noNL?: boolean;
}

interface UHunk {
  a: number;
  body: UEntry[];
}

interface USection {
  oldP?: string;
  newP?: string;
  diffOld?: string;
  diffNew?: string;
  renameFrom?: string;
  renameTo?: string;
  isNew?: boolean;
  isDel?: boolean;
  hunks: UHunk[];
}

function trimBodyEnd(h: UHunk): void {
  while (h.body.length > 0) {
    const last = h.body[h.body.length - 1]!;
    if (last.type === 'ctx' && last.text === '') h.body.pop();
    else break;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let curHunk: UHunk | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) perr(i + 1);
      if (curHunk !== null) trimBodyEnd(curHunk);
      cur = { diffOld: m[1], diffNew: m[2], hunks: [] };
      sections.push(cur);
      curHunk = null;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        if (curHunk !== null) trimBodyEnd(curHunk);
        cur = { hunks: [] };
        sections.push(cur);
        curHunk = null;
      }
      const oldRaw = line.slice(4).split('\t')[0]!.trim();
      const newRaw = lines[i + 1]!.slice(4).split('\t')[0]!.trim();
      cur.oldP = oldRaw;
      cur.newP = newRaw;
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) perr(i + 2);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isNew = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDel = true;
        i += 1;
        continue;
      }
      if (!line.startsWith('@@')) {
        i += 1;
        continue;
      }
      // '@@' falls through to the hunk handling below.
    }
    if (line.startsWith('@@')) {
      if (cur === null) perr(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/.exec(line);
      if (!m) perr(i + 1);
      if (curHunk !== null) trimBodyEnd(curHunk);
      curHunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(curHunk);
      i += 1;
      continue;
    }
    if (curHunk !== null) {
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line[0] === '\\') {
          const last = curHunk.body[curHunk.body.length - 1];
          if (last !== undefined) last.noNL = true;
        } else if (line === '') {
          curHunk.body.push({ type: 'ctx', text: '' });
        } else {
          curHunk.body.push({
            type: line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : 'new',
            text: line.slice(1),
          });
        }
        i += 1;
        continue;
      }
      trimBodyEnd(curHunk);
      curHunk = null;
      continue;
    }
    i += 1;
  }
  if (curHunk !== null) trimBodyEnd(curHunk);
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function lastCtxOrNewNoNL(h: UHunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k -= 1) {
    const e = h.body[k]!;
    if (e.type === 'ctx' || e.type === 'new') return e.noNL === true;
  }
  return false;
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldRaw = sec.oldP !== undefined ? stripAB(sec.oldP) : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newRaw = sec.newP !== undefined ? stripAB(sec.newP) : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const oldP = oldRaw ?? newRaw;
  const newP = newRaw ?? oldRaw;
  const isCreate = (sec.oldP !== undefined && stripAB(sec.oldP) === '/dev/null') || sec.isNew === true;
  const isDelete = (sec.newP !== undefined && stripAB(sec.newP) === '/dev/null') || sec.isDel === true;
  return (tree) => {
    if (oldP === undefined || newP === undefined) throw new Fail('missing', oldP ?? newP ?? '');
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const outLines: string[] = [];
      let lastPlus: UEntry | null = null;
      for (const h of sec.hunks) {
        for (const e of h.body) {
          if (e.type === 'new') {
            outLines.push(e.text);
            lastPlus = e;
          }
        }
      }
      const final = !(lastPlus !== null && lastPlus.noNL === true);
      tree.now.set(newP, outLines.length === 0 ? '' : outLines.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n, oCtx, nCtx } = splitON(h.body);
      if (o.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const wasEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...n);
        if (wasEnd && n.length > 0) f.final = !lastCtxOrNewNoNL(h);
        d += n.length;
        continue;
      }
      const found = findTier(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', oldP);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const runsToEnd = best + o.length === f.lines.length;
      const repl = buildReplacement(f.lines, best, o, n, oCtx, nCtx, found.tier);
      f.lines.splice(best, o.length, ...repl);
      if (runsToEnd) f.final = !lastCtxOrNewNoNL(h);
      d += n.length - o.length;
    }
    const text = joinFile(f);
    if (isMove) tree.move(oldP, newP, text);
    else tree.now.set(oldP, text);
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) perr(searchIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) perr(searchIdx + 1);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) perr(searchIdx + 1);
      path = prevPath;
    }
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const repl = buildReplacement(
      f.lines,
      at,
      oldLines,
      newLines,
      oldLines.map(() => false),
      newLines.map(() => false),
      found.tier,
    );
    f.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(p, joinFile(f));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string;
  eof: boolean;
  body: { type: 'ctx' | 'old' | 'new'; text: string }[];
}

interface VUpdate {
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) perr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') perr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') perr(lines.length + 1);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const secLines: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        secLines.push(lines[j]!);
        j += 1;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
      for (let k = 0; k < secLines.length; k++) {
        const l = secLines[k]!;
        if (l !== '' && !l.startsWith('+')) perr(i + 2 + k);
      }
      const content = secLines.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) perr(j + 1);
        j += 1;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const upd = parseVUpdate(raw, i + 1);
      edits.push(vUpdateEdit(p, upd, strict));
      i = j;
      continue;
    }
    perr(i + 1);
  }
  return edits;
}

function parseVUpdate(raw: string[], updateLineNo: number): VUpdate {
  let moveTo: string | null = null;
  let k = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let closed = false;
  for (; k < raw.length; k++) {
    const l = raw[k]!;
    const lineNo = updateLineNo + 1 + k;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
      chunks.push(cur);
      closed = false;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) perr(lineNo);
      cur.eof = true;
      cur = null;
      closed = true;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0 && !closed) {
          cur = { anchor: '', eof: false, body: [] };
          chunks.push(cur);
        } else {
          perr(lineNo);
        }
      }
      cur.body.push({
        type: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new',
        text: l === '' ? '' : l.slice(1),
      });
      continue;
    }
    perr(lineNo);
  }
  if (chunks.length === 0 && moveTo === null) perr(updateLineNo);
  return { moveTo, chunks };
}

function vUpdateEdit(p: string, upd: VUpdate, strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const newP = upd.moveTo;
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of upd.chunks) {
      if (ch.anchor !== '') {
        const tiers = strict ? [0] : [0, 1, 2];
        let foundAt = -1;
        for (const t of tiers) {
          for (let idx = cursor; idx < f.lines.length; idx++) {
            if (normLine(f.lines[idx]!, t) === normLine(ch.anchor, t)) {
              foundAt = idx;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      const { o, n, oCtx, nCtx } = splitON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...n);
        cursor = at + n.length;
        continue;
      }
      const found = findTier(f.lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      let occ = found.occ;
      if (ch.eof) {
        occ = occ.filter((pos) => pos + o.length === f.lines.length);
        if (occ.length === 0) throw new Fail('no-match', p);
      }
      const at = occ[0]!;
      const repl = buildReplacement(f.lines, at, o, n, oCtx, nCtx, found.tier);
      f.lines.splice(at, o.length, ...repl);
      cursor = at + repl.length;
    }
    const text = joinFile(f);
    if (newP !== null) tree.move(p, newP, text);
    else tree.now.set(p, text);
  };
}


function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rowList: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [newP, origP] of tree.moves) {
    if (
      tree.get(origP) === null &&
      tree.now.get(newP) !== null &&
      tree.now.get(newP) !== undefined &&
      tree.original(origP) !== null &&
      tree.original(newP) === null
    ) {
      rowList.push({ key: newP, line: `R ${origP} -> ${newP}` });
      suppressed.add(origP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
