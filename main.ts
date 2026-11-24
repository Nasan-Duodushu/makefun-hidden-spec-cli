// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Successful move edits, as [old path, new path], for the `R` output lines of section 2. */
  readonly moves: [string, string][] = [];
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

// ---------------------------------------------------------------------------
// Sections 5 to 8, written for this entry: tiered line matching, unified
// diffs, SEARCH/REPLACE blocks and V4A patches. A body item is one line of a
// hunk or chunk: `c` context (in both O and N), `d` old only, `a` new only.
// ---------------------------------------------------------------------------

type Item = { k: 'c' | 'd' | 'a'; t: string };

interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function normAt(line: string, tier: number): string {
  return tier === 0 ? line : tier === 1 ? trimTrail(line) : trimBoth(line);
}

/** Every start position where O matches the file lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const found: number[] = [];
  if (o.length === 0) return found;
  const want = o.map((l) => normAt(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normAt(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier with an occurrence at or after `from`, and its positions; null when no tier has one. */
function matchFrom(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const at = occurrences(lines, o, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/**
 * Replace the matched lines at `pos` with the body's new side. Context lines
 * are written as the file's own matched lines; at tier 2 the added lines are
 * re-indented from O's first line's indent to the file's (section 5).
 */
function spliceItems(file: Split, pos: number, items: Item[], tier: number): string[] {
  const oFirst = items.find((x) => x.k !== 'a');
  const pIndent = oFirst === undefined ? '' : leadWs(oFirst.t);
  const fIndent = file.lines[pos] === undefined ? '' : leadWs(file.lines[pos]!);
  const out: string[] = [];
  let oi = pos;
  for (const it of items) {
    if (it.k === 'c') {
      out.push(file.lines[oi]!);
      oi += 1;
    } else if (it.k === 'd') {
      oi += 1;
    } else {
      let t = it.t;
      if (tier === 2 && t.trim() !== '' && pIndent !== '' && t.startsWith(pIndent)) {
        t = fIndent + t.slice(pIndent.length);
      } else if (tier === 2 && t.trim() !== '' && pIndent === '') {
        t = fIndent + t;
      }
      out.push(t);
    }
  }
  return [...file.lines.slice(0, pos), ...out, ...file.lines.slice(oi)];
}

const oldOf = (items: Item[]): string[] => items.filter((x) => x.k !== 'a').map((x) => x.t);
const newOf = (items: Item[]): string[] => items.filter((x) => x.k !== 'd').map((x) => x.t);

/** Whether a `\` line follows the body's last context or `+` line (section 6's final-break rule). */
function backslashAfterLastWrite(body: (Item | '\\')[]): boolean {
  let last = -1;
  body.forEach((x, i) => {
    if (x !== '\\' && x.k !== 'd') last = i;
  });
  return last >= 0 && body[last + 1] === '\\';
}

function mustExist(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

function mustNotExist(tree: Tree, p: string): void {
  if (tree.get(p) !== null) throw new Fail('exists', p);
}

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// --- Section 6: unified diffs ----------------------------------------------

interface Hunk {
  a: number;
  items: (Item | '\\')[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  creates: boolean;
  deletes: boolean;
  hunks: Hunk[];
  sawHeader: boolean;
}

const newSection = (): Section => ({
  gitOld: null, gitNew: null, oldPath: null, newPath: null,
  renameFrom: null, renameTo: null, creates: false, deletes: false, hunks: [], sawHeader: false,
});

function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last !== '\\' && last.k === 'c' && last.t === '') hunk.items.pop();
        else break;
      }
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const isBodyLine = (l: string): boolean =>
    l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      closeHunk();
      if (sec === null || sec.sawHeader || sec.hunks.length > 0) {
        sec = newSection();
        sections.push(sec);
      }
      sec.oldPath = headerPath(l.slice(4));
      sec.newPath = headerPath(lines[i + 1]!.slice(4));
      sec.sawHeader = true;
      i += 1;
      continue;
    }
    if (hunk !== null && isBodyLine(l) && !l.startsWith('--- ')) {
      if (l.startsWith('\\')) hunk.items.push('\\');
      else if (l === '') hunk.items.push({ k: 'c', t: '' });
      else hunk.items.push({ k: l[0] === ' ' ? 'c' : l[0] === '-' ? 'd' : 'a', t: l.slice(1) });
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null || sec === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      hunk = { a: Number(m[1]), items: [] };
      continue;
    }
    closeHunk();
    if (sec !== null && sec.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) sec.creates = true;
      else if (l.startsWith('deleted file mode')) sec.deletes = true;
    }
  }
  closeHunk();
  return sections.map((s) => unifiedApply(s));
}

function unifiedApply(sec: Section): Edit {
  return (tree) => {
    const oldPath = sec.oldPath ?? sec.renameFrom ?? sec.gitOld;
    const newPath = sec.newPath ?? sec.renameTo ?? sec.gitNew;
    const creates = sec.creates || oldPath === '/dev/null';
    const deletes = sec.deletes || newPath === '/dev/null';
    if (creates) {
      const p = newPath!;
      checkSafe(p);
      mustNotExist(tree, p);
      const items = sec.hunks.flatMap((h) => h.items);
      const plus = items.filter((x) => x !== '\\' && x.k === 'a') as Item[];
      const lastPlus = items.lastIndexOf(plus[plus.length - 1]!);
      const noBreak = plus.length > 0 && items[lastPlus + 1] === '\\';
      const file: Split = { lines: plus.map((x) => x.t), br: '\n', final: plus.length > 0 && !noBreak };
      tree.now.set(p, joinFile(file));
      return;
    }
    if (deletes) {
      const p = oldPath!;
      checkSafe(p);
      mustExist(tree, p);
      tree.now.set(p, null);
      return;
    }
    const from = oldPath!;
    const to = newPath ?? from;
    checkSafe(from);
    if (to !== from) checkSafe(to);
    const before = mustExist(tree, from);
    if (to !== from) mustNotExist(tree, to);
    let file = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const o = oldOf(h.items.filter((x) => x !== '\\') as Item[]);
      const n = newOf(h.items.filter((x) => x !== '\\') as Item[]);
      const items = h.items.filter((x) => x !== '\\') as Item[];
      if (o.length === 0) {
        const at = Math.min(h.a + d, file.lines.length);
        const endsAtEnd = at === file.lines.length;
        file = { ...file, lines: [...file.lines.slice(0, at), ...n, ...file.lines.slice(at)] };
        if (endsAtEnd && n.length > 0) file.final = !backslashAfterLastWrite(h.items);
      } else {
        const m = matchFrom(file.lines, o, STRICT);
        if (m === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let pos = m.at[0]!;
        for (const cand of m.at) {
          if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        }
        const runsToEnd = pos + o.length === file.lines.length;
        file = { ...file, lines: spliceItems(file, pos, items, m.tier) };
        if (runsToEnd) file.final = !backslashAfterLastWrite(h.items);
      }
      d += n.length - o.length;
    }
    if (to !== from) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
    tree.now.set(to, joinFile(file));
  };
}

// --- Section 7: SEARCH/REPLACE blocks ---------------------------------------

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    let mid = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (mid < 0 && lines[j]!.trimEnd() === '=======') mid = j;
      else if (mid >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (mid < 0 || end < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, mid);
    const newLines = lines.slice(mid + 1, end);
    const p = path;
    edits.push((tree) => {
      checkSafe(p);
      if (oldLines.length === 0) {
        mustNotExist(tree, p);
        tree.now.set(p, joinFile({ lines: [...newLines], br: '\n', final: newLines.length > 0 }));
        return;
      }
      const file = splitFile(mustExist(tree, p));
      const m = matchFrom(file.lines, oldLines, STRICT);
      if (m === null) throw new Fail('no-match', p);
      if (m.at.length > 1) throw new Fail('ambiguous', p);
      // No context lines here: the new lines simply replace the matched ones,
      // with section 5's tier-2 re-indentation applied to each of them.
      const replaced = [...file.lines.slice(0, m.at[0]!), ...newLines.map((t) => {
        if (m.tier === 2 && t.trim() !== '') {
          const f = leadWs(file.lines[m.at[0]!] ?? '');
          const pl = leadWs(oldLines[0] ?? '');
          if (pl !== '' && t.startsWith(pl)) return f + t.slice(pl.length);
          if (pl === '') return f + t;
        }
        return t;
      }), ...file.lines.slice(m.at[0]! + oldLines.length)];
      tree.now.set(p, joinFile({ ...file, lines: replaced }));
    });
    prevPath = p;
    searchFrom = end + 1;
    i = end;
  }
  return edits;
}

// --- Section 8: V4A patches --------------------------------------------------

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : 'upd';
    const p = l.slice(l.indexOf(': ') + 2).trim();
    const sectionLine = i + 1;
    i += 1;
    const body: string[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      body.push(lines[i]!);
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      body.forEach((b, bi) => {
        if (b.startsWith('+')) fileLines.push(b.slice(1));
        else if (b === '') fileLines.push('');
        else throw new Exit2(`error: parse ${sectionLine + 1 + bi}`);
      });
      edits.push((tree) => {
        checkSafe(p);
        mustNotExist(tree, p);
        tree.now.set(p, joinFile({ lines: fileLines, br: '\n', final: fileLines.length > 0 }));
      });
    } else if (kind === 'del') {
      if (body.some((b) => !blank(b))) throw new Exit2(`error: parse ${sectionLine + 1}`);
      edits.push((tree) => {
        checkSafe(p);
        mustExist(tree, p);
        tree.now.set(p, null);
      });
    } else {
      edits.push(v4aUpdate(p, body, sectionLine));
    }
  }
  return edits;
}

function v4aUpdate(p: string, body: string[], sectionLine: number): Edit {
  let moveTo: string | null = null;
  let at = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    at = 1;
  }
  interface Chunk {
    anchor: string | null;
    eof: boolean;
    items: Item[];
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (let bi = at; bi < body.length; bi++) {
    const b = body[bi]!;
    if (b.startsWith('@@')) {
      cur = { anchor: b.slice(2).trim() === '' ? null : b.slice(2).trim(), eof: false, items: [] };
      chunks.push(cur);
      continue;
    }
    if (b === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, eof: true, items: [] };
        chunks.push(cur);
      } else cur.eof = true;
      continue;
    }
    if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
      if (cur === null) {
        cur = { anchor: null, eof: false, items: [] };
        chunks.push(cur);
      }
      cur.items.push({ k: b === '' || b[0] === ' ' ? 'c' : b[0] === '-' ? 'd' : 'a', t: b === '' ? '' : b.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${sectionLine + 1 + bi}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
  return (tree) => {
    checkSafe(p);
    if (moveTo !== null) checkSafe(moveTo);
    const file0 = splitFile(mustExist(tree, p));
    if (moveTo !== null) mustNotExist(tree, moveTo);
    let file = file0;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (let tier = 0; tier <= (STRICT ? 0 : 2) && found < 0; tier++) {
          const atLines = occurrences(file.lines, [ch.anchor], tier, cursor);
          if (atLines.length > 0) found = atLines[0]!;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const o = oldOf(ch.items);
      const n = newOf(ch.items);
      if (o.length === 0) {
        const pos = ch.eof ? file.lines.length : cursor;
        file = { ...file, lines: [...file.lines.slice(0, pos), ...n, ...file.lines.slice(pos)] };
        cursor = pos + n.length;
        continue;
      }
      const m = matchFrom(file.lines, o, STRICT, cursor);
      if (m === null) throw new Fail('no-match', p);
      let pos = m.at[0]!;
      if (ch.eof) {
        const ends = m.at.filter((x) => x + o.length === file.lines.length);
        if (ends.length === 0) throw new Fail('no-match', p);
        pos = ends[0]!;
      }
      file = { ...file, lines: spliceItems(file, pos, ch.items, m.tier) };
      cursor = pos + n.length;
    }
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.moves.push([p, moveTo]);
      tree.now.set(moveTo, joinFile(file));
    } else {
      tree.now.set(p, joinFile(file));
    }
  };
}

let STRICT = false;

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
  STRICT = strict;
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines)
          : kind === 'search-replace'
            ? srEdits(lines)
            : v4aEdits(lines);
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
  // Section 2's listing: one row per changed path in byte order, with a
  // successful move shown as a single `R` row sorted by its new path.
  const changed = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rows: { key: string; text: string }[] = [];
  const paired = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (!changed.has(from) || !changed.has(to) || paired.has(from) || paired.has(to)) continue;
    if (tree.original(from) === null || tree.now.get(from) !== null) continue;
    if (tree.original(to) !== null || tree.now.get(to) === null) continue;
    paired.add(from);
    paired.add(to);
    rows.push({ key: to, text: `R ${from} -> ${to}` });
  }
  for (const [p, text] of changed) {
    if (!paired.has(p)) rows.push({ key: p, text });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
