import { parseDocument, isMap, isSeq, isScalar, Scalar, YAMLMap, Pair, Node } from 'yaml';

/**
 * A structural model of a Kaizo file, mirroring how kaizo/parser.py actually treats it:
 *  - top-level `isolated`, `local`, `import`, `plugins` are popped, everything else is an entry
 *  - a mapping is executable only if both `module` and `source` are present and non-null
 *  - only a string that is *exactly* `<module>.<key>.{<sub>}` is a reference (re.match with ^...$)
 *  - entries are resolved in file order; an entry is referenceable only after it is finished
 */

export interface Span {
  start: number;
  end: number;
}
export interface StrVal {
  text: string;
  span: Span;
}
export interface ArgKey {
  name: string;
  key: Span;
  /** end offset of the argument's value: the kwarg exists once its value is resolved */
  valueEnd: number;
}
export interface ArgsInfo {
  kind: 'map' | 'list' | 'str' | 'null' | 'other';
  /** span of the `args` key */
  key: Span;
  value: Span;
  keys: ArgKey[];
  count: number;
  str?: StrVal;
}
export interface EntryUse {
  /** top-level key (or plugin name) this entry lives under */
  top: string | undefined;
  map: Span;
  module: StrVal;
  source: StrVal;
  /** `call` value: boolean or method name; undefined when absent */
  call?: { value: boolean | string; span: Span };
  lazy?: boolean;
  args?: ArgsInfo;
  /** entries[ ] position of keys, for quick diagnostics */
  keys: Map<string, { key: Span; value: Span }>;
}
export interface TopKey {
  name: string;
  key: Span;
  pair: Span;
  /** kwarg names available as `.name.{kwarg}` */
  argNames: ArgKey[];
}
export interface RefUse {
  kind: 'full' | 'partial';
  span: Span;
  text: string;
  top: string | undefined;
  module: string;
  key?: string;
  sub: string;
  moduleSpan: Span;
  keySpan?: Span;
  subSpan: Span;
}
export interface PluginDecl {
  name: string;
  key: Span;
  pair: Span;
  className?: StrVal;
  argNames: ArgKey[];
  args?: ArgsInfo;
  shape: 'string' | 'map' | 'other';
  /** property keys when it is a mapping */
  props: { name: string; key: Span }[];
}
export interface PathDecl {
  key: Span;
  path: StrVal | undefined;
  raw: unknown;
  valueSpan: Span;
}
export interface Model {
  parseErrors: { start: number; end: number; message: string; code: string; severity: 'error' | 'warning' }[];
  rootIsMap: boolean;
  rootSpan?: Span;
  top: TopKey[];
  imports: Map<string, PathDecl>;
  importKeysRaw: { name: string; key: Span }[];
  importShape: 'map' | 'other' | 'none';
  importSpan?: Span;
  local?: PathDecl;
  plugins: PluginDecl[];
  pluginsShape: 'map' | 'other' | 'none';
  pluginsSpan?: Span;
  isolated?: { key: Span; value: Span; ok: boolean };
  entries: EntryUse[];
  refs: RefUse[];
  /** mappings that have `module` xor `source` plus other entry-like keys: probably a typo */
  incomplete: { present: string; presentKey: Span; missing: string; near?: { name: string; key: Span } }[];
}

function levenshteinLite(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export const REF_FULL = /^(\w*)\.(?:(\w+)\.)?\{(\w*)\}$/;
const REF_LOOSE = /\w*\.(?:\w+\.)?\{\w*\}/;
export const RESERVED = new Set(['import', 'local', 'plugins', 'isolated']);

const span = (n: unknown): Span | undefined => {
  const r = (n as Node | null | undefined)?.range;
  return r ? { start: r[0], end: r[1] } : undefined;
};

function keyOf(p: Pair): string | undefined {
  return isScalar(p.key) && typeof p.key.value === 'string' ? p.key.value : undefined;
}
function getPair(map: YAMLMap, name: string): Pair | undefined {
  return map.items.find((p) => keyOf(p as Pair) === name) as Pair | undefined;
}

export function isExecutable(map: YAMLMap): boolean {
  const m = getPair(map, 'module');
  const s = getPair(map, 'source');
  const nonNull = (p: Pair) => !(isScalar(p.value) ? p.value.value === null : p.value === null || p.value === undefined);
  return !!m && !!s && nonNull(m) && nonNull(s);
}

export function emptyModel(): Model {
  return {
    parseErrors: [], rootIsMap: false, top: [], imports: new Map(), importKeysRaw: [], importShape: 'none',
    plugins: [], pluginsShape: 'none', entries: [], refs: [], incomplete: [],
  };
}

/** Span of a scalar's content, excluding surrounding quotes. */
function strVal(s: Scalar, text: string): StrVal | undefined {
  if (typeof s.value !== 'string' || !s.range) return undefined;
  let [a, b] = [s.range[0], s.range[1]];
  const q = text[a];
  if ((q === '"' || q === "'") && text[b - 1] === q && b - a >= 2) {
    a += 1;
    b -= 1;
  }
  return { text: s.value, span: { start: a, end: b } };
}

export function buildModel(text: string): Model {
  const m = emptyModel();
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  for (const e of doc.errors) m.parseErrors.push({ start: e.pos[0], end: Math.max(e.pos[1], e.pos[0] + 1), message: e.message.split('\n')[0], code: 'yaml-' + e.code, severity: 'error' });
  for (const w of doc.warnings) m.parseErrors.push({ start: w.pos[0], end: Math.max(w.pos[1], w.pos[0] + 1), message: w.message.split('\n')[0], code: 'yaml-' + w.code, severity: 'warning' });

  const root = doc.contents;
  if (!root) return m;
  m.rootSpan = span(root);
  if (!isMap(root)) return m;
  m.rootIsMap = true;

  const argsInfo = (pair: Pair, collect: ArgKey[]): ArgsInfo => {
    const v = pair.value;
    const keySpan = span(pair.key)!;
    const valueSpan = span(v) ?? keySpan;
    const info: ArgsInfo = { kind: 'other', key: keySpan, value: valueSpan, keys: [], count: 0 };
    if (isMap(v)) {
      info.kind = 'map';
      for (const ap of v.items as Pair[]) {
        const n = keyOf(ap);
        if (!n) continue;
        const ak: ArgKey = { name: n, key: span(ap.key)!, valueEnd: span(ap.value)?.end ?? span(ap.key)!.end };
        info.keys.push(ak);
        collect.push(ak);
        info.count++;
      }
    } else if (isSeq(v)) {
      info.kind = 'list';
      info.count = v.items.length;
    } else if (isScalar(v)) {
      if (v.value === null) info.kind = 'null';
      else if (typeof v.value === 'string') {
        info.kind = 'str';
        info.str = strVal(v, text);
      }
    }
    return info;
  };

  const scanRef = (s: Scalar, top: string | undefined) => {
    if (typeof s.value !== 'string' || !s.range) return;
    const value = s.value;
    const sp = { start: s.range[0], end: s.range[1] };
    const full = REF_FULL.exec(value);
    if (full) {
      const raw = text.slice(sp.start, sp.end);
      const q = raw.startsWith(value) ? 0 : raw.slice(1).startsWith(value) ? 1 : -1;
      let pos = sp.start + Math.max(q, 0);
      const moduleSpan = { start: pos, end: pos + full[1].length };
      pos += full[1].length + 1;
      let keySpan: Span | undefined;
      if (full[2] !== undefined) {
        keySpan = { start: pos, end: pos + full[2].length };
        pos += full[2].length + 1;
      }
      pos += 1;
      const subSpan = { start: pos, end: pos + full[3].length };
      m.refs.push({ kind: 'full', span: q < 0 ? sp : { start: sp.start + q, end: sp.start + q + value.length }, text: value, top, module: full[1], key: full[2], sub: full[3], moduleSpan, keySpan, subSpan });
    } else if (REF_LOOSE.test(value)) {
      m.refs.push({ kind: 'partial', span: sp, text: value, top, module: '', sub: '', moduleSpan: sp, subSpan: sp });
    }
  };

  const noteIncomplete = (map: YAMLMap) => {
    const mod = getPair(map, 'module');
    const src = getPair(map, 'source');
    if (!mod && !src) return;
    const present = mod ? 'module' : 'source';
    const missing = mod ? 'source' : 'module';
    const pp = (mod ?? src)!;
    const keys = (map.items as Pair[]).map((p) => ({ name: keyOf(p), key: span(p.key)! })).filter((k) => k.name && k.name !== present) as { name: string; key: Span }[];
    // only flag when it looks like an entry was intended: entry-like keys, or a near-miss of the missing key
    const entryLike = keys.some((k) => ['args', 'call', 'lazy', 'cache', 'policy'].includes(k.name));
    const near = keys.find((k) => k.name !== missing && levenshteinLite(k.name, missing) <= 2);
    const nullish = pp.value === null || (isScalar(pp.value) && pp.value.value === null);
    const otherPresent = getPair(map, missing);
    if (otherPresent && !nullish) return; // other side is present but null => treated as data, user is likely mid-edit
    if (entryLike || near) m.incomplete.push({ present, presentKey: span(pp.key)!, missing, near });
  };

  const walkValue = (node: unknown, top: string | undefined, collect: ArgKey[]) => {
    if (isScalar(node)) return scanRef(node, top);
    if (isSeq(node)) return node.items.forEach((i) => walkValue(i, top, collect));
    if (!isMap(node)) return;
    if (isExecutable(node)) return walkEntry(node, top, collect);
    noteIncomplete(node);
    for (const p of node.items as Pair[]) walkValue(p.value, top, collect);
  };

  const walkArgsValue = (pair: Pair, top: string | undefined, collect: ArgKey[]) => {
    const v = pair.value;
    if (isMap(v)) for (const ap of v.items as Pair[]) walkValue(ap.value, top, collect);
    else if (isSeq(v)) v.items.forEach((i) => walkValue(i, top, collect));
    else if (isScalar(v)) scanRef(v, top);
  };

  const walkEntry = (map: YAMLMap, top: string | undefined, collect: ArgKey[]) => {
    const mod = getPair(map, 'module')!;
    const src = getPair(map, 'source')!;
    const keys = new Map<string, { key: Span; value: Span }>();
    for (const p of map.items as Pair[]) {
      const n = keyOf(p);
      if (n) keys.set(n, { key: span(p.key)!, value: span(p.value) ?? span(p.key)! });
    }
    const mv = isScalar(mod.value) ? strVal(mod.value, text) : undefined;
    const sv = isScalar(src.value) ? strVal(src.value, text) : undefined;
    const entry: EntryUse = {
      top,
      map: span(map) ?? { start: 0, end: 0 },
      module: mv ?? { text: '', span: span(mod.value) ?? span(mod.key)! },
      source: sv ?? { text: '', span: span(src.value) ?? span(src.key)! },
      keys,
    };
    const cp = getPair(map, 'call');
    if (cp && isScalar(cp.value) && (typeof cp.value.value === 'boolean' || typeof cp.value.value === 'string')) {
      entry.call = { value: cp.value.value, span: (typeof cp.value.value === 'string' ? strVal(cp.value, text)?.span : span(cp.value)) ?? span(cp.value)! };
    }
    const lp = getPair(map, 'lazy');
    if (lp && isScalar(lp.value) && typeof lp.value.value === 'boolean') entry.lazy = lp.value.value;
    const ap = getPair(map, 'args');
    if (ap) {
      entry.args = argsInfo(ap, collect);
      walkArgsValue(ap, top, collect);
    }
    m.entries.push(entry);
  };

  for (const p of root.items as Pair[]) {
    const k = keyOf(p);
    if (!k) continue;
    const keySpan = span(p.key)!;
    const pairSpan = { start: keySpan.start, end: span(p.value)?.end ?? keySpan.end };
    const v = p.value;

    if (k === 'import') {
      m.importSpan = span(v) ?? keySpan;
      if (isMap(v)) {
        m.importShape = 'map';
        for (const ip of v.items as Pair[]) {
          const n = keyOf(ip);
          if (!n) continue;
          m.importKeysRaw.push({ name: n, key: span(ip.key)! });
          const sv = isScalar(ip.value) ? strVal(ip.value, text) : undefined;
          m.imports.set(n, { key: span(ip.key)!, path: sv, raw: isScalar(ip.value) ? ip.value.value : ip.value, valueSpan: span(ip.value) ?? span(ip.key)! });
        }
      } else m.importShape = 'other';
    } else if (k === 'local') {
      const sv = isScalar(v) ? strVal(v, text) : undefined;
      m.local = { key: keySpan, path: sv, raw: isScalar(v) ? v.value : v, valueSpan: span(v) ?? keySpan };
    } else if (k === 'isolated') {
      m.isolated = { key: keySpan, value: span(v) ?? keySpan, ok: isScalar(v) && typeof v.value === 'boolean' };
    } else if (k === 'plugins') {
      m.pluginsSpan = span(v) ?? keySpan;
      if (isMap(v)) {
        m.pluginsShape = 'map';
        for (const pp of v.items as Pair[]) {
          const n = keyOf(pp);
          if (!n) continue;
          const pv = pp.value;
          const decl: PluginDecl = {
            name: n, key: span(pp.key)!, pair: { start: span(pp.key)!.start, end: span(pv)?.end ?? span(pp.key)!.end },
            argNames: [], shape: 'other', props: [],
          };
          if (isScalar(pv) && typeof pv.value === 'string') {
            decl.shape = 'string';
            decl.className = strVal(pv, text);
          } else if (isMap(pv)) {
            decl.shape = 'map';
            for (const f of pv.items as Pair[]) {
              const fk = keyOf(f);
              if (fk) decl.props.push({ name: fk, key: span(f.key)! });
            }
            const sp = getPair(pv, 'source');
            if (sp && isScalar(sp.value)) decl.className = strVal(sp.value, text);
            const ap = getPair(pv, 'args');
            if (ap) {
              decl.args = argsInfo(ap, decl.argNames);
              walkArgsValue(ap, n, decl.argNames);
            }
          }
          m.plugins.push(decl);
        }
      } else m.pluginsShape = 'other';
    } else {
      const tk: TopKey = { name: k, key: keySpan, pair: pairSpan, argNames: [] };
      m.top.push(tk);
      walkValue(v, k, tk.argNames);
    }
  }
  return m;
}

/** Lines → offset helper. */
export function offsetAt(text: string, line: number, col: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) return text.length;
    off = nl + 1;
  }
  return Math.min(off + col, text.length);
}
export function positionAt(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let last = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      last = i + 1;
    }
  }
  return { line, col: Math.min(offset, text.length) - last };
}

export const within = (s: Span | undefined, off: number) => !!s && off >= s.start && off <= s.end;
