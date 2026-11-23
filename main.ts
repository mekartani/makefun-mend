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

type Move = [string, string];
type Edit = (tree: Tree, moves: Move[]) => void;

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

// ---------- section 5: matching lines ----------

function normLine(s: string, t: number): string {
  if (t === 0) return s;
  let r = s.replace(/[ \t]+$/, '');
  if (t === 2) r = r.replace(/^[ \t]+/, '');
  return r;
}

function occurrences(O: string[], file: string[], t: number, from = 0): number[] {
  const out: number[] = [];
  outer: for (let i = from; i + O.length <= file.length; i += 1) {
    for (let j = 0; j < O.length; j += 1) {
      if (normLine(file[i + j]!, t) !== normLine(O[j]!, t)) continue outer;
    }
    out.push(i);
  }
  return out;
}

function matchTier(O: string[], file: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const p = occurrences(O, file, t, from);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

function lead(s: string): string {
  return /^[ \t]*/.exec(s)![0];
}

function reindent(line: string, P: string, F: string): string {
  if (line.trim() === '') return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

type BodyLine = { t: string; s: string };

function buildON(body: BodyLine[]): { O: string[]; N: { s: string; ctx: boolean }[]; map: number[] } {
  const O: string[] = [];
  const N: { s: string; ctx: boolean }[] = [];
  const map: number[] = [];
  let o = 0;
  for (const b of body) {
    if (b.t === ' ') {
      O.push(b.s);
      N.push({ s: b.s, ctx: true });
      map.push(o);
      o += 1;
    } else if (b.t === '-') {
      O.push(b.s);
      o += 1;
    } else if (b.t === '+') {
      N.push({ s: b.s, ctx: false });
      map.push(-1);
    }
  }
  return { O, N, map };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function noNewlineMark(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) if (body[i]!.t === ' ' || body[i]!.t === '+') last = i;
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.t === '\\';
}

type FileBuf = { lines: string[]; br: string; ends: boolean };

function readFileBuf(text: string): FileBuf {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function bufText(f: FileBuf): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

function applyHunks(f: FileBuf, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N, map } = buildON(h.body);
    if (O.length > 0) {
      const m = matchTier(O, f.lines, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = m.positions[0]!;
      for (const p of m.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const oldLen = f.lines.length;
      const ranToEnd = pos + O.length === oldLen;
      const out: string[] = [];
      for (let n = 0; n < N.length; n += 1) {
        const e = N[n]!;
        if (e.ctx) out.push(f.lines[pos + map[n]!]!);
        else out.push(m.tier === 2 ? reindent(e.s, lead(O[0]!), lead(f.lines[pos]!)) : e.s);
      }
      f.lines.splice(pos, O.length, ...out);
      if (ranToEnd) f.ends = !noNewlineMark(h.body);
      d += N.length - O.length;
    } else {
      const ins = Math.min(h.a + d, f.lines.length);
      const out = N.map((e) => e.s);
      const atEnd = ins === f.lines.length;
      f.lines.splice(ins, 0, ...out);
      if (atEnd) f.ends = !noNewlineMark(h.body);
      d += N.length - O.length;
    }
  }
}

// ---------- section 6: unified diffs ----------

type Hunk = { a: number; body: BodyLine[] };
type USec = { old: string | null; new: string | null; create: boolean; del: boolean; hunks: Hunk[]; hasPair: boolean };

function stripAB(p: string): string | null {
  let t = p;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t === '/dev/null' ? null : t;
}

function diffPath(rest: string): string | null {
  const seg = rest.split('\t')[0]!.replace(/^ +/, '').replace(/ +$/, '');
  return stripAB(seg);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { old: m[1]!, new: m[2]!, create: false, del: false, hunks: [], hasPair: false };
      secs.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      if (cur === null || cur.hasPair || cur.hunks.length > 0) {
        cur = { old: null, new: null, create: false, del: false, hunks: [], hasPair: false };
        secs.push(cur);
      }
      cur.old = diffPath(l.slice(4));
      cur.new = diffPath(lines[i + 1]!.slice(4));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && !cur.hasPair && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const h: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) break;
        if (b === '') {
          h.body.push({ t: ' ', s: '' });
          j += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          h.body.push({ t: c, s: b.slice(1) });
          j += 1;
          continue;
        }
        if (c === '\\') {
          h.body.push({ t: '\\', s: b.slice(1) });
          j += 1;
          continue;
        }
        break;
      }
      while (h.body.length > 0 && h.body[h.body.length - 1]!.t === ' ' && h.body[h.body.length - 1]!.s === '') h.body.pop();
      cur.hunks.push(h);
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.old = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.new = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USec, strict: boolean): Edit {
  return (tree, moves) => {
    const creation = s.old === null || s.create;
    const deletion = s.new === null || s.del;
    if (creation) {
      const p = s.new;
      if (p === null) throw new Fail('missing', s.old ?? '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const ls: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.t === '+') ls.push(b.s);
      let ends = true;
      for (const h of s.hunks) if (noNewlineMark(h.body)) ends = false;
      tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + (ends ? '\n' : ''));
      return;
    }
    if (deletion) {
      const p = s.old;
      if (p === null) throw new Fail('missing', s.new ?? '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = s.old ?? s.new!;
    const np = s.new ?? s.old!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    if (tree.get(op) === null) throw new Fail('missing', op);
    if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
    const f = readFileBuf(tree.get(op)!);
    applyHunks(f, s.hunks, strict, op);
    if (op !== np) {
      tree.now.set(op, null);
      tree.now.set(np, bufText(f));
      moves.push([op, np]);
    } else {
      tree.now.set(op, bufText(f));
    }
  };
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

type SRBlock = { path: string; old: string[]; new: string[] };

function parseSR(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let lastEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > lastEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, old: lines.slice(i + 1, j), new: lines.slice(j + 1, k) });
    prevPath = path;
    lastEnd = k;
    i = k + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
      return;
    }
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    const f = readFileBuf(t);
    const m = matchTier(b.old, f.lines, strict);
    if (m === null) throw new Fail('no-match', p);
    if (m.positions.length !== 1) throw new Fail('ambiguous', p);
    const pos = m.positions[0]!;
    const out = m.tier === 2 ? b.new.map((l) => reindent(l, lead(b.old[0]!), lead(f.lines[pos]!))) : b.new;
    f.lines.splice(pos, b.old.length, ...out);
    tree.now.set(p, bufText(f));
  };
}

// ---------- section 8: V4A patches ----------

type VChunk = { anchor: string | null; eof: boolean; body: BodyLine[] };
type VSec = { line: number; kind: 'add' | 'del' | 'upd'; path: string; moveTo: string | null; file: string[]; pend: number; blanks: number; chunks: VChunk[] };

function parseV4A(lines: string[], strict: boolean): Edit[] {
  let fi = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!blank(lines[i]!)) {
      fi = i;
      break;
    }
  }
  if (fi < 0 || lines[fi]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fi < 0 ? 1 : fi + 1}`);
  let li = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      li = i;
      break;
    }
  }
  if (lines[li]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: VSec[] = [];
  let cur: VSec | null = null;
  const close = (): void => {
    if (cur === null) return;
    if (cur.kind === 'upd' && cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.line + 1}`);
    cur = null;
  };
  for (let i = fi + 1; i < li; i += 1) {
    const l = lines[i]!;
    const t = l.trim();
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      close();
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : 'upd';
      const path = (kind === 'add' ? l.slice(14) : l.slice(17)).trim();
      cur = { line: i, kind, path, moveTo: null, file: [], pend: 0, blanks: 0, chunks: [] };
      secs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (blank(l)) {
        cur.pend += 1;
        continue;
      }
      if (l.startsWith('+')) {
        while (cur.pend > 0) {
          cur.file.push('');
          cur.pend -= 1;
        }
        cur.file.push(l.slice(1));
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'del') {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.moveTo === null && cur.chunks.length === 0 && l.startsWith('*** Move to: ')) {
      cur.moveTo = l.slice(13).trim();
      cur.blanks = 0;
      continue;
    }
    if (t === '*** End of File') {
      const ch = cur.chunks.length > 0 ? cur.chunks[cur.chunks.length - 1]! : null;
      if (ch === null || ch.eof) throw new Exit2(`error: parse ${i + 1}`);
      while (cur.blanks > 0) {
        ch.body.push({ t: ' ', s: '' });
        cur.blanks -= 1;
      }
      ch.eof = true;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur.chunks.length > 0 && !cur.chunks[cur.chunks.length - 1]!.eof) {
        const ch = cur.chunks[cur.chunks.length - 1]!;
        while (cur.blanks > 0) {
          ch.body.push({ t: ' ', s: '' });
          cur.blanks -= 1;
        }
      } else {
        cur.blanks = 0;
      }
      const a = l.slice(2).trim();
      cur.chunks.push({ anchor: a === '' ? null : a, eof: false, body: [] });
      continue;
    }
    if (blank(l)) {
      cur.blanks += 1;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      let ch = cur.chunks.length > 0 ? cur.chunks[cur.chunks.length - 1]! : null;
      if (ch === null || ch.eof) {
        cur.blanks = 0;
        ch = { anchor: null, eof: false, body: [] };
        cur.chunks.push(ch);
      } else {
        while (cur.blanks > 0) {
          ch.body.push({ t: ' ', s: '' });
          cur.blanks -= 1;
        }
      }
      ch.body.push({ t: l[0]!, s: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  close();
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSec, strict: boolean): Edit {
  return (tree, moves) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.file.length === 0 ? '' : s.file.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (tree.get(s.path) === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = readFileBuf(tree.get(s.path)!);
    let cursor = 0;
    for (const ch of s.chunks) {
      const { O, N, map } = buildON(ch.body);
      let pos = -1;
      let tier = 0;
      if (O.length > 0) {
        if (ch.eof) {
          let done = false;
          for (const t of strict ? [0] : [0, 1, 2]) {
            for (let p = cursor; p + O.length <= f.lines.length; p += 1) {
              let ok = true;
              for (let j = 0; j < O.length; j += 1) {
                if (normLine(f.lines[p + j]!, t) !== normLine(O[j]!, t)) {
                  ok = false;
                  break;
                }
              }
              if (ok && p + O.length === f.lines.length) {
                pos = p;
                tier = t;
                done = true;
                break;
              }
            }
            if (done) break;
          }
          if (!done) throw new Fail('no-match', s.path);
        } else {
          if (ch.anchor !== null) {
            let ai = -1;
            for (const t of strict ? [0] : [0, 1, 2]) {
              for (let p = cursor; p < f.lines.length; p += 1) {
                if (normLine(f.lines[p]!, t) === normLine(ch.anchor, t)) {
                  ai = p;
                  break;
                }
              }
              if (ai >= 0) break;
            }
            if (ai < 0) throw new Fail('no-match', s.path);
            cursor = ai + 1;
          }
          const m = matchTier(O, f.lines, strict, cursor);
          if (m === null) throw new Fail('no-match', s.path);
          pos = m.positions[0]!;
          tier = m.tier;
        }
      }
      if (O.length > 0) {
        const out: string[] = [];
        for (let n = 0; n < N.length; n += 1) {
          const e = N[n]!;
          if (e.ctx) out.push(f.lines[pos + map[n]!]!);
          else out.push(tier === 2 ? reindent(e.s, lead(O[0]!), lead(f.lines[pos]!)) : e.s);
        }
        f.lines.splice(pos, O.length, ...out);
        cursor = pos + N.length;
      } else {
        const ins = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const out = N.map((e) => e.s);
        f.lines.splice(ins, 0, ...out);
        cursor = ins + out.length;
      }
    }
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, bufText(f));
      moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, bufText(f));
    }
  };
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
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSR(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveOld = new Set<string>();
  const moveNew = new Map<string, string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      moveOld.add(o);
      moveNew.set(n, o);
    }
  }
  const rows: string[] = [];
  const changed = [...tree.now.keys()]
    .filter((p) => tree.original(p) !== tree.now.get(p))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (moveOld.has(p)) {
      if (!check) rmSync(p, { force: true });
      continue;
    }
    if (moveNew.has(p)) rows.push(`R ${moveNew.get(p)} -> ${p}`);
    else rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
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
