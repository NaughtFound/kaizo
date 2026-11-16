import * as path from 'path';
import { buildModel, EntryUse, Model, positionAt, offsetAt, Span, within, TopKey } from './index';
import { getContext } from './context';
import { hasMethod, MethodInfo, ModuleInfo, Param, PythonService, SymbolInfo } from './python';
import { COMMON_MODULES, ENTRY_PROPS, PLUGIN_PROPS, POLICY_VALUES, PropDoc, SPECIAL_MODULES, STDLIB, TOP_LEVEL } from './spec';

export interface Deps {
  py?: PythonService;
  /** extra python search paths (workspace roots, settings, ...) */
  extra: string[];
  /** absolute path of the document (undefined for untitled) */
  filePath?: string;
  readFile(p: string): string | undefined;
  exists(p: string): boolean;
  listFiles(dir: string, exts: string[]): string[];
  /** every Kaizo file of the workspace (for cross-file references / rename) */
  workspaceFiles?(): Promise<string[]>;
}

export interface Loc {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface Item {
  label: string;
  kind: 'keyword' | 'property' | 'module' | 'class' | 'function' | 'variable' | 'value' | 'enum' | 'file' | 'snippet' | 'reference' | 'method' | 'field';
  detail?: string;
  doc?: string;
  insert?: string;
  snippet?: boolean;
  sort?: string;
  /** offsets in the document that the item replaces (default: the word before the cursor) */
  replace?: Span;
  /** lets the host resolve extra details lazily */
  data?: { module: string; name: string; extra: string[] };
  retrigger?: boolean;
}

export interface HoverResult {
  span: Span;
  markdown: string;
}

const dirOf = (d: Deps) => (d.filePath ? path.dirname(d.filePath) : undefined);

// ---------------------------------------------------------------------------------------------
// shared resolution helpers
// ---------------------------------------------------------------------------------------------

export interface PyTarget {
  moduleName?: string;
  mod?: ModuleInfo | null;
  sym?: SymbolInfo | null;
  isPlugin: boolean;
  /** python module that holds the plugin class (kaizo.plugins.<name>) */
  pluginModule?: string;
}

export function extraPaths(model: Model, d: Deps): string[] {
  const dir = dirOf(d);
  const out: string[] = [];
  if (dir && model.local?.path) out.push(path.dirname(path.resolve(dir, model.local.path.text)));
  return [...out, ...d.extra];
}

export function localModuleName(model: Model, d: Deps): string | undefined {
  const dir = dirOf(d);
  if (!dir || !model.local?.path) return undefined;
  const p = path.resolve(dir, model.local.path.text);
  return d.exists(p) ? '@file:' + p : undefined;
}

/** Work out which python module/symbol a (module, source) pair refers to and load it. */
export async function resolveTarget(model: Model, d: Deps, moduleText: string, sourceText: string, wantSymbol = true): Promise<PyTarget> {
  const t: PyTarget = { isPlugin: moduleText === 'plugin' };
  const py = d.py;
  const extra = extraPaths(model, d);
  if (!py) return t;
  let sourceName = sourceText;
  if (t.isPlugin) {
    const decl = model.plugins.find((p) => p.name === sourceText);
    if (!decl?.className) return t;
    t.moduleName = t.pluginModule = `kaizo.plugins.${decl.name}`;
    sourceName = decl.className.text;
  } else if (moduleText === 'local') {
    t.moduleName = localModuleName(model, d);
  } else if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(moduleText)) {
    t.moduleName = moduleText;
  }
  if (!t.moduleName) return t;
  await py.ensure({ modules: [t.moduleName], symbols: wantSymbol && sourceName ? [{ module: t.moduleName, name: sourceName }] : [] }, extra);
  t.mod = py.peekModule(t.moduleName, extra);
  t.sym = wantSymbol && sourceName ? py.peekSymbol(t.moduleName, sourceName, extra) : undefined;
  return t;
}

function nameRange(d: Deps, file: string | null, line: number, col: number, name: string): Loc | undefined {
  if (!file) return undefined;
  const text = d.readFile(file);
  if (text === undefined) return { file, line, col, endLine: line, endCol: col };
  const l = text.split(/\r?\n/)[line] ?? '';
  let idx = l.indexOf(name, col);
  if (idx < 0) idx = col;
  return { file, line, col: idx, endLine: line, endCol: idx + name.length };
}

function spanLoc(file: string, text: string, s: Span): Loc {
  const a = positionAt(text, s.start);
  const b = positionAt(text, s.end);
  return { file, line: a.line, col: a.col, endLine: b.line, endCol: b.col };
}

const FILE_TOP: Loc = { file: '', line: 0, col: 0, endLine: 0, endCol: 0 };

function importedFile(model: Model, d: Deps, alias: string): { file: string; text: string; model: Model } | undefined {
  const dir = dirOf(d);
  const decl = model.imports.get(alias);
  if (!dir || !decl?.path) return undefined;
  const file = path.resolve(dir, decl.path.text);
  const text = d.readFile(file);
  if (text === undefined) return undefined;
  return { file, text, model: buildModel(text) };
}

// ---------------------------------------------------------------------------------------------
// go to definition
// ---------------------------------------------------------------------------------------------

export async function definitionAt(text: string, offset: number, d: Deps): Promise<Loc[]> {
  const model = buildModel(text);
  const here = d.filePath ?? '';
  const dir = dirOf(d);
  const out: Loc[] = [];
  const fileLoc = (file: string): Loc => ({ ...FILE_TOP, file });

  // --- references .{x}, m.{x}, .k.{p}, m.k.{p}
  for (const r of model.refs) {
    if (r.kind !== 'full' || !within(r.span, offset)) continue;
    const onModule = r.module !== '' && within(r.moduleSpan, offset) && offset < r.moduleSpan.end + 1;
    const onKey = r.keySpan && within(r.keySpan, offset);
    const find = (m: Model, file: string, src: string) => {
      const plugin = (n: string) => m.plugins.find((p) => p.name === n);
      return { m, file, src, plugin };
    };
    let scope = find(model, here, text);
    if (r.module) {
      const imp = importedFile(model, d, r.module);
      if (onModule) {
        if (imp) return [fileLoc(imp.file)];
        const decl = model.imports.get(r.module);
        return decl ? [spanLoc(here, text, decl.key)] : [];
      }
      if (!imp) return [];
      scope = find(imp.model, imp.file, imp.text);
    }
    const loc = (s: Span) => spanLoc(scope.file, scope.src, s);
    if (r.key !== undefined) {
      const k = scope.m.top.find((t) => t.name === r.key);
      const pl = scope.plugin(r.key);
      if (onKey) return k ? [loc(k.key)] : pl ? [loc(pl.key)] : [];
      const names = k?.argNames ?? pl?.argNames ?? [];
      // the last definition wins in kaizo's storage; prefer the one nearest above the reference
      const hits = names.filter((a) => a.name === r.sub);
      const hit = (!r.module && hits.filter((a) => a.key.start < r.span.start).pop()) || hits[0];
      if (hit) return [loc(hit.key)];
      return k ? [loc(k.key)] : [];
    }
    const k = scope.m.top.find((t) => t.name === r.sub);
    return k ? [loc(k.key)] : [];
  }

  // --- import / local paths
  for (const [alias, decl] of model.imports) {
    if ((decl.path && within(decl.path.span, offset)) || within(decl.key, offset)) {
      if (dir && decl.path) {
        const f = path.resolve(dir, decl.path.text);
        if (d.exists(f)) return [fileLoc(f)];
      }
      void alias;
    }
  }
  if (model.local?.path && within(model.local.path.span, offset) && dir) {
    const f = path.resolve(dir, model.local.path.text);
    if (d.exists(f)) return [fileLoc(f)];
  }

  // --- plugin declarations: key -> module file, class -> class definition
  for (const p of model.plugins) {
    if (!d.py) break;
    const onClass = p.className && within(p.className.span, offset);
    const onKey = within(p.key, offset);
    if (!onClass && !onKey) continue;
    const extra = extraPaths(model, d);
    const modName = `kaizo.plugins.${p.name}`;
    await d.py.ensure({ modules: [modName], symbols: p.className ? [{ module: modName, name: p.className.text }] : [] }, extra);
    const mod = d.py.peekModule(modName, extra);
    const sym = p.className ? d.py.peekSymbol(modName, p.className.text, extra) : undefined;
    if (onClass && sym?.file) {
      const l = nameRange(d, sym.file, sym.line, sym.col, sym.name);
      if (l) return [l];
    }
    if (mod?.file) return [fileLoc(mod.file)];
    return [];
  }

  // --- entries
  for (const e of model.entries) {
    const onModule = within(e.module.span, offset);
    const onSource = within(e.source.span, offset);
    const onCall = e.call && typeof e.call.value === 'string' && within(e.call.span, offset);
    const argKey = e.args?.keys.find((k) => within(k.key, offset));
    if (!onModule && !onSource && !onCall && !argKey) continue;

    if (e.module.text === 'plugin') {
      const decl = model.plugins.find((p) => p.name === e.source.text);
      if (onSource || onModule) return decl ? [spanLoc(here, text, decl.key)] : [];
    }
    const t = await resolveTarget(model, d, e.module.text, e.source.text);
    if (onModule) {
      if (t.mod?.file) return [fileLoc(t.mod.file)];
      return [];
    }
    if (onSource) {
      if (t.sym?.file) {
        const l = nameRange(d, t.sym.file, t.sym.line, t.sym.col, t.sym.name);
        if (l) return [l];
      }
      return t.mod?.file ? [fileLoc(t.mod.file)] : [];
    }
    if (onCall && t.sym) {
      const m = t.sym.methods[String(e.call!.value)];
      if (m?.file) {
        const l = nameRange(d, m.file, m.line, m.col, String(e.call!.value));
        if (l) return [l];
      }
      return [];
    }
    if (argKey && t.sym) {
      const params = paramsFor(e, t);
      const p = params?.find((x) => x.name === argKey.name);
      if (p?.file && p.line !== undefined) {
        const l = nameRange(d, p.file, p.line, p.col ?? 0, p.name);
        if (l) return [l];
      }
      if (t.sym.file) {
        const l = nameRange(d, t.sym.file, t.sym.line, t.sym.col, t.sym.name);
        if (l) return [l];
      }
    }
    return [];
  }

  // --- top-level key under cursor on a definition: nothing to jump to
  return out;
}

/** Parameters that `args` is passed to, following kaizo/utils/entry.py semantics. */
export function paramsFor(e: Pick<EntryUse, 'call'>, t: PyTarget): Param[] | null | undefined {
  const sym = t.sym;
  if (!sym) return undefined;
  const call = e.call?.value;
  if (call === false) return null;
  if (typeof call === 'string') {
    const m: MethodInfo | undefined = sym.methods[call];
    if (!m) return null;
    return m.kind === 'method' && !t.isPlugin ? null : m.params;
  }
  if (t.isPlugin) return sym.methods['__call__']?.params ?? null;
  return sym.kind === 'class' || sym.kind === 'function' ? sym.params : null;
}

// ---------------------------------------------------------------------------------------------
// hover
// ---------------------------------------------------------------------------------------------

function fence(lang: string, code: string) {
  return '```' + lang + '\n' + code + '\n```';
}

function symbolMarkdown(sym: SymbolInfo): string {
  const head =
    sym.kind === 'class' ? `class ${sym.name}${sym.sig ?? '(...)'}` : sym.kind === 'function' ? `def ${sym.name}${sym.sig ?? '(...)'}` : sym.kind === 'module' ? `module ${sym.target ?? sym.name}` : `${sym.name}`;
  let md = fence('python', head);
  md += `\n\n*${sym.module}*`;
  if (sym.doc) md += `\n\n${sym.doc}`;
  return md;
}

function paramMarkdown(p: Param, owner: string): string {
  const sig = `${p.name}${p.annotation ? ': ' + p.annotation : ''}${p.default !== null ? ' = ' + p.default : ''}`;
  return fence('python', `(parameter) ${sig}`) + `\n\n${p.required ? '**required**' : 'optional'} · \`${owner}\``;
}

export async function hoverAt(text: string, offset: number, d: Deps): Promise<HoverResult | undefined> {
  const model = buildModel(text);

  for (const r of model.refs) {
    if (r.kind !== 'full' || !within(r.span, offset)) continue;
    let scopeModel = model;
    let scopeText = text;
    let label = '';
    if (r.module) {
      const imp = importedFile(model, d, r.module);
      if (!imp) return { span: r.span, markdown: `Import \`${r.module}\` could not be loaded.` };
      scopeModel = imp.model;
      scopeText = imp.text;
      label = ` (in \`${r.module}\`)`;
      if (within(r.moduleSpan, offset)) return { span: r.moduleSpan, markdown: `**import** \`${r.module}\` → \`${model.imports.get(r.module)?.path?.text ?? ''}\`` };
    }
    if (r.key === undefined) {
      const k = scopeModel.top.find((t) => t.name === r.sub);
      if (!k) return { span: r.span, markdown: `\`${r.sub}\` is not defined in this file${label}; it would have to be a runtime kwarg.` };
      const body = scopeText.slice(k.pair.start, Math.min(k.pair.end, k.pair.start + 600));
      return { span: r.span, markdown: `**entry** \`${r.sub}\`${label}\n\n${fence('yaml', body)}` };
    }
    const k = scopeModel.top.find((t) => t.name === r.key);
    const arg = k?.argNames.find((a) => a.name === r.sub);
    if (!arg) return { span: r.span, markdown: `\`${r.key}\` has no argument \`${r.sub}\`${label}.` };
    const line = scopeText.slice(arg.key.start, Math.min(arg.valueEnd, arg.key.start + 400));
    return { span: r.span, markdown: `**argument** \`${r.sub}\` of \`${r.key}\`${label}\n\n${fence('yaml', line)}` };
  }

  for (const e of model.entries) {
    const onModule = within(e.module.span, offset);
    const onSource = within(e.source.span, offset);
    const onCall = e.call && typeof e.call.value === 'string' && within(e.call.span, offset);
    const argKey = e.args?.keys.find((k) => within(k.key, offset));
    if (!onModule && !onSource && !onCall && !argKey) continue;

    if (onModule && (e.module.text === 'local' || e.module.text === 'plugin')) {
      const sp = SPECIAL_MODULES.find((m) => m.name === e.module.text)!;
      return { span: e.module.span, markdown: `**module: ${sp.name}** — ${sp.detail}\n\n${sp.doc}` };
    }
    const t = await resolveTarget(model, d, e.module.text, e.source.text);
    if (onModule) {
      if (t.mod === null) return { span: e.module.span, markdown: `Module \`${e.module.text}\` was not found in the selected Python environment.` };
      if (t.mod) return { span: e.module.span, markdown: `**Python module** \`${e.module.text}\`\n\n${t.mod.file ? '`' + t.mod.file + '`' : '*built-in*'}` };
      return undefined;
    }
    if (onSource) {
      if (e.module.text === 'plugin') {
        const decl = model.plugins.find((p) => p.name === e.source.text);
        if (decl && t.sym) return { span: e.source.span, markdown: `**plugin** \`${decl.name}\`\n\n${symbolMarkdown(t.sym)}` };
        return decl ? { span: e.source.span, markdown: `**plugin** \`${decl.name}\` → \`${decl.className?.text ?? '?'}\`` } : undefined;
      }
      if (t.sym) return { span: e.source.span, markdown: symbolMarkdown(t.sym) };
      if (t.mod === null) return undefined;
      return undefined;
    }
    if (onCall && t.sym) {
      const name = String(e.call!.value);
      const m = t.sym.methods[name];
      if (!m) return { span: e.call!.span, markdown: `\`${t.sym.name}\` has no method \`${name}\`.` };
      const sig = m.params ? '(' + m.params.map((p) => p.name + (p.default !== null ? '=' + p.default : '')).join(', ') + ')' : '(...)';
      return { span: e.call!.span, markdown: fence('python', `def ${name}${sig}`) + (m.doc ? `\n\n${m.doc}` : '') + `\n\n*${m.kind} of ${t.sym.name}*` };
    }
    if (argKey) {
      const params = paramsFor(e, t);
      const p = params?.find((x) => x.name === argKey.name);
      if (p) return { span: argKey.key, markdown: paramMarkdown(p, t.sym?.name ?? e.source.text) };
      if (params && !params.some((x) => x.kind === 'varkw')) return { span: argKey.key, markdown: `\`${argKey.name}\` is not a parameter of \`${t.sym?.name}\`.` };
    }
  }

  // plain property docs
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', offset);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const m = /^(\s*(?:-\s+)*)([A-Za-z_][\w-]*)\s*:/.exec(line);
  if (m) {
    const s = lineStart + m[1].length;
    const span = { start: s, end: s + m[2].length };
    if (within(span, offset)) {
      const top = !/^\s/.test(line);
      const hit: PropDoc | undefined = (top ? TOP_LEVEL : ENTRY_PROPS).find((p) => p.name === m[2]) ?? PLUGIN_PROPS.find((p) => p.name === m[2]);
      if (hit && (top || model.entries.some((e) => within(e.map, offset)) || model.plugins.some((p) => within(p.pair, offset)))) {
        return { span, markdown: `**${hit.name}** — ${hit.detail}\n\n${hit.doc}` };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------------------------

const KIND: Record<string, Item['kind']> = { class: 'class', function: 'function', var: 'variable', module: 'module', import: 'reference', unknown: 'variable' };

function memberItems(info: ModuleInfo, moduleName: string, extra: string[]): Item[] {
  const names = Object.keys(info.members).filter((n) => !n.startsWith('_'));
  return names.map((n) => ({
    label: n,
    kind: KIND[info.members[n]] ?? 'variable',
    detail: info.members[n] === 'import' ? 'imported name' : info.members[n],
    data: { module: moduleName, name: n, extra },
  }));
}

export async function completionsAt(text: string, offset: number, d: Deps): Promise<Item[]> {
  const pos = positionAt(text, offset);
  const lines = text.split(/\r?\n/);
  const ctx = getContext(lines, pos.line, pos.col);
  const model = buildModel(text);
  const extra = extraPaths(model, d);

  if (ctx.kind === 'none') return [];

  // ---- `.{`, `alias.{`, `.entry.{`, `alias.entry.{`
  if (ctx.kind === 'reference') {
    const segs = ctx.prefix.split('.').slice(0, -1); // '.' -> [''], 'a.' -> ['a'], '.k.' -> ['', 'k'], 'a.k.' -> ['a','k']
    const [mod, key] = [segs[0] ?? '', segs[1]];
    const out: Item[] = [];
    const replace = { start: offset - ctx.typed.length, end: offset };
    const wrap = (label: string, kind: Item['kind'], detail?: string): Item => ({ label, kind, detail, replace, insert: label });
    if (mod === '' && key === undefined) {
      for (const t of model.top) if (t.pair.end <= offset && t.pair.start < offset) out.push(wrap(t.name, 'variable', 'entry'));
      return out;
    }
    let scope: Model | undefined = model;
    if (mod !== '') {
      const imp = importedFile(model, d, mod);
      scope = imp?.model;
      if (!scope) return out;
      if (key === undefined) {
        for (const t of scope.top) out.push(wrap(t.name, 'variable', `entry of ${mod}`));
        return out;
      }
    }
    if (key !== undefined && scope) {
      const t = scope.top.find((x) => x.name === key) ?? scope.plugins.find((x) => x.name === key);
      for (const a of t?.argNames ?? []) {
        if (mod !== '' || a.valueEnd <= offset) out.push(wrap(a.name, 'field', `argument of ${key}`));
      }
    }
    return dedupe(out);
  }

  // ---- values
  if (ctx.kind === 'value') {
    const p = ctx.path;
    const top = p.length === 0;
    const typedStart = offset - ctx.typed.length;
    const word = (s: string) => ({ start: typedStart, end: offset, s });
    void word;
    const replaceAll: Span = { start: typedStart, end: offset };
    const simple = (label: string, kind: Item['kind'], detail?: string, doc?: string): Item => ({ label, kind, detail, doc, replace: replaceAll });

    if (ctx.key === 'module' && !top) {
      const items: Item[] = SPECIAL_MODULES.map((m) => ({ ...simple(m.name, 'keyword', m.detail, m.doc), sort: '0' + m.name }));
      const typed = ctx.typed.trim();
      const py = d.py;
      if (py && py.available !== false) {
        const lastDot = typed.lastIndexOf('.');
        const prefix = lastDot >= 0 ? typed.slice(0, lastDot + 1) : '';
        await py.ensure({ lists: [prefix] }, extra);
        const list = py.peekList(prefix, extra);
        if (list) {
          for (const e of list) {
            items.push({ label: e.name, kind: 'module', detail: e.pkg ? 'package' : 'module', replace: { start: typedStart + prefix.length, end: offset }, sort: '1' + e.name, retrigger: e.pkg });
          }
          return items;
        }
      }
      for (const m of COMMON_MODULES) items.push({ ...simple(m, 'module', 'Python module'), sort: '1' + m });
      return items;
    }

    if (ctx.key === 'source' && !top) {
      const modTxt = ctx.siblings.get('module')?.replace(/^["']|["']$/g, '');
      if (p.length >= 2 && p[0] === 'plugins') return [];
      if (modTxt === 'plugin') return model.plugins.map((pl) => simple(pl.name, 'class', `plugin → ${pl.className?.text ?? '?'}`));
      if (modTxt === 'local') {
        const lm = localModuleName(model, d);
        if (lm && d.py) {
          await d.py.ensure({ modules: [lm] }, extra);
          const info = d.py.peekModule(lm, extra);
          if (info) return memberItems(info, lm, extra).map((i) => ({ ...i, replace: replaceAll }));
        }
        return [];
      }
      if (modTxt && d.py && d.py.available !== false) {
        await d.py.ensure({ modules: [modTxt] }, extra);
        const info = d.py.peekModule(modTxt, extra);
        if (info) return memberItems(info, modTxt, extra).map((i) => ({ ...i, replace: replaceAll }));
        if (info === null) return [];
      }
      if (modTxt && STDLIB[modTxt]) return STDLIB[modTxt].map((n) => simple(n, 'function', `${modTxt}.${n}`));
      return [];
    }

    if (ctx.key === 'call' && !top) {
      const modTxt = ctx.siblings.get('module')?.replace(/^["']|["']$/g, '');
      const srcTxt = ctx.siblings.get('source')?.replace(/^["']|["']$/g, '');
      const items: Item[] = ['true', 'false'].map((v) => simple(v, 'value'));
      if (modTxt && srcTxt) {
        const t = await resolveTarget(model, d, modTxt, srcTxt);
        if (t.sym?.kind === 'class') {
          for (const [n, m] of Object.entries(t.sym.methods)) {
            if (n.startsWith('_') || m.kind === 'property' || m.kind === 'attr') continue;
            items.push({ ...simple(n, 'method', `${m.kind} · ${t.sym.name}`), doc: m.doc ?? undefined, sort: '0' + n });
          }
        }
      }
      return items;
    }
    if (['lazy', 'cache'].includes(ctx.key) || (ctx.key === 'isolated' && top)) return ['true', 'false'].map((v) => simple(v, 'value'));
    if (ctx.key === 'policy') return POLICY_VALUES.map((v) => simple(v, 'enum', 'exception policy'));
    const dir = dirOf(d);
    if (dir && ((ctx.key === 'local' && top) || (p.length === 1 && p[0] === 'import'))) {
      const exts = ctx.key === 'local' && top ? ['.py'] : ['.kiz', '.yaml', '.yml'];
      return d
        .listFiles(dir, exts)
        .filter((f) => f !== d.filePath)
        .map((f) => {
          const r = path.relative(dir, f).split(path.sep).join('/');
          return simple(r.startsWith('.') ? r : './' + r, 'file');
        });
    }
    return [];
  }

  // ---- keys
  const have = new Set(ctx.siblings.keys());
  const p = ctx.path;
  const replace: Span = { start: offset - ctx.typed.length, end: offset };
  const prop = (x: PropDoc, kind: Item['kind']): Item => ({ label: x.name, kind, detail: x.detail, doc: x.doc, insert: x.name + ': ', replace, retrigger: true });

  if (p.length === 0) {
    const items = TOP_LEVEL.filter((x) => !have.has(x.name)).map((x) => prop(x, 'keyword'));
    items.push(
      { label: 'entry', kind: 'snippet', detail: 'Kaizo entry', snippet: true, insert: '${1:name}:\n  module: ${2:builtins}\n  source: ${3:print}\n  args:\n    - $0', sort: 'z1', replace },
      { label: 'lazy-entry', kind: 'snippet', detail: 'Kaizo lazy entry', snippet: true, insert: '${1:name}:\n  module: ${2:time}\n  source: ${3:sleep}\n  lazy: true\n  args:\n    - $0', sort: 'z2', replace },
    );
    return items;
  }
  if (p.length === 1 && (p[0] === 'plugins' || p[0] === 'import')) return [];
  if (p.length === 2 && p[0] === 'plugins') return PLUGIN_PROPS.filter((x) => !have.has(x.name)).map((x) => prop(x, 'property'));

  // keyword argument names: `args:` mapping of an executable entry
  if (p[p.length - 1] === 'args') {
    const parent = ctx.parent;
    const modTxt = parent?.get('module')?.replace(/^["']|["']$/g, '');
    const srcTxt = parent?.get('source')?.replace(/^["']|["']$/g, '');
    if (!modTxt || !srcTxt) return [];
    const t = await resolveTarget(model, d, modTxt, srcTxt);
    const callRaw = parent?.get('call');
    const callVal: boolean | string | undefined = callRaw === undefined ? undefined : callRaw === 'true' ? true : callRaw === 'false' ? false : callRaw.replace(/^["']|["']$/g, '');
    const params = paramsFor({ call: callVal === undefined ? undefined : { value: callVal, span: { start: 0, end: 0 } } }, t);
    if (!params) return [];
    return params
      .filter((x) => x.kind !== 'varargs' && x.kind !== 'varkw' && x.kind !== 'posonly' && !have.has(x.name))
      .map((x) => ({
        label: x.name,
        kind: 'field' as const,
        detail: `${x.annotation ?? ''}${x.default !== null ? (x.annotation ? ' = ' : '= ') + x.default : ''}`.trim() || (x.required ? 'required' : 'optional'),
        doc: x.required ? '**required**' : undefined,
        insert: x.name + ': ',
        sort: (x.required ? '0' : '1') + x.name,
        replace,
        retrigger: true,
      }));
  }
  return ENTRY_PROPS.filter((x) => !have.has(x.name)).map((x) => prop(x, 'property'));
}

function dedupe(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.label) ? false : (seen.add(i.label), true)));
}

/** Details for a completion item resolved lazily (signature + docs). */
export async function resolveItem(item: Item, d: Deps): Promise<Partial<Item>> {
  const x = item.data;
  if (!x || !d.py) return {};
  await d.py.ensure({ symbols: [{ module: x.module, name: x.name }] }, x.extra);
  const s = d.py.peekSymbol(x.module, x.name, x.extra);
  if (!s) return {};
  return { detail: `${s.kind}${s.sig ?? ''}`, doc: symbolMarkdown(s) };
}

// ---------------------------------------------------------------------------------------------
// references / rename
// ---------------------------------------------------------------------------------------------

interface RefTarget {
  file: string;
  key: string;
  arg?: string;
  span: Span;
  kind: 'key' | 'alias';
}

function targetAt(model: Model, text: string, offset: number, d: Deps): RefTarget | undefined {
  const here = d.filePath ?? '';
  for (const t of model.top) {
    if (within(t.key, offset)) return { file: here, key: t.name, span: t.key, kind: 'key' };
    const a = t.argNames.find((x) => within(x.key, offset));
    if (a) return { file: here, key: t.name, arg: a.name, span: a.key, kind: 'key' };
  }
  for (const p of model.plugins) {
    if (within(p.key, offset)) return { file: here, key: p.name, span: p.key, kind: 'key' };
    const a = p.argNames.find((x) => within(x.key, offset));
    if (a) return { file: here, key: p.name, arg: a.name, span: a.key, kind: 'key' };
  }
  for (const [alias, decl] of model.imports) if (within(decl.key, offset)) return { file: here, key: alias, span: decl.key, kind: 'alias' };
  for (const r of model.refs) {
    if (r.kind !== 'full' || !within(r.span, offset)) continue;
    if (r.module && within(r.moduleSpan, offset) && offset <= r.moduleSpan.end) return { file: here, key: r.module, span: r.moduleSpan, kind: 'alias' };
    const imp = r.module ? importedFile(model, d, r.module) : undefined;
    if (r.module && !imp) return undefined;
    const file = imp ? imp.file : here;
    if (r.key !== undefined) {
      if (r.keySpan && within(r.keySpan, offset)) return { file, key: r.key, span: r.keySpan, kind: 'key' };
      return { file, key: r.key, arg: r.sub, span: r.subSpan, kind: 'key' };
    }
    return { file, key: r.sub, span: r.subSpan, kind: 'key' };
  }
  return undefined;
}

export async function referencesAt(text: string, offset: number, d: Deps, includeDeclaration = true): Promise<Loc[]> {
  const model = buildModel(text);
  const target = targetAt(model, text, offset, d);
  if (!target) return [];
  const here = d.filePath ?? '';
  const out: Loc[] = [];

  if (target.kind === 'alias') {
    for (const r of model.refs) if (r.kind === 'full' && r.module === target.key) out.push(spanLoc(here, text, r.moduleSpan));
    if (includeDeclaration) out.push(spanLoc(here, text, model.imports.get(target.key)!.key));
    return out;
  }

  const files = new Set<string>([here, ...((await d.workspaceFiles?.()) ?? [])].filter(Boolean));
  for (const f of files) {
    const ft = f === here ? text : d.readFile(f);
    if (ft === undefined) continue;
    const fm = f === here ? model : buildModel(ft);
    const dir = path.dirname(f);
    const aliasFile = new Map<string, string>();
    for (const [a, decl] of fm.imports) if (decl.path) aliasFile.set(a, path.resolve(dir, decl.path.text));
    for (const r of fm.refs) {
      if (r.kind !== 'full') continue;
      const scope = r.module === '' ? f : aliasFile.get(r.module);
      if (!scope || path.resolve(scope) !== path.resolve(target.file)) continue;
      if (r.key === undefined) {
        if (!target.arg && r.sub === target.key) out.push(spanLoc(f, ft, r.subSpan));
      } else if (r.key === target.key) {
        if (!target.arg && r.keySpan) out.push(spanLoc(f, ft, r.keySpan));
        else if (target.arg && r.sub === target.arg) out.push(spanLoc(f, ft, r.subSpan));
      }
    }
  }
  if (includeDeclaration) {
    const tf = target.file;
    const tt = tf === here ? text : d.readFile(tf);
    if (tt !== undefined) {
      const tm = tf === here ? model : buildModel(tt);
      const top = tm.top.find((t) => t.name === target.key) ?? tm.plugins.find((p) => p.name === target.key);
      if (top) {
        if (!target.arg) out.push(spanLoc(tf, tt, top.key));
        else for (const a of top.argNames) if (a.name === target.arg) out.push(spanLoc(tf, tt, a.key));
      }
    }
  }
  return out;
}

/** What would be renamed at the cursor? Only entry names and import aliases (kwargs belong to Python). */
export function prepareRenameAt(text: string, offset: number, d: Deps): { span: Span; name: string } | undefined {
  const model = buildModel(text);
  const t = targetAt(model, text, offset, d);
  if (!t || t.arg) return undefined;
  return { span: t.span, name: t.key };
}

export async function renameAt(text: string, offset: number, d: Deps, newName: string): Promise<{ edits: Loc[] } | { error: string }> {
  if (!/^\w+$/.test(newName)) return { error: 'Kaizo references only allow letters, digits and underscore in names.' };
  const model = buildModel(text);
  const t = targetAt(model, text, offset, d);
  if (!t || t.arg) return { error: 'Only entry names and import aliases can be renamed.' };
  if (t.kind === 'key') {
    const tf = t.file;
    const tt = tf === (d.filePath ?? '') ? text : d.readFile(tf);
    const tm = tt === undefined ? undefined : tf === (d.filePath ?? '') ? model : buildModel(tt);
    if (tm?.top.some((x) => x.name === newName) || tm?.plugins.some((x) => x.name === newName)) return { error: `\`${newName}\` already exists.` };
  } else if (model.imports.has(newName)) return { error: `Import \`${newName}\` already exists.` };
  return { edits: await referencesAt(text, offset, d, true) };
}

// ---------------------------------------------------------------------------------------------
// document links + outline
// ---------------------------------------------------------------------------------------------

export function linksIn(text: string, d: Deps): { span: Span; file: string }[] {
  const dir = dirOf(d);
  if (!dir) return [];
  const model = buildModel(text);
  const out: { span: Span; file: string }[] = [];
  const decls = [...model.imports.values(), ...(model.local ? [model.local] : [])];
  for (const decl of decls) {
    if (!decl.path) continue;
    const f = path.resolve(dir, decl.path.text);
    if (d.exists(f)) out.push({ span: decl.path.span, file: f });
  }
  return out;
}

export interface OutlineNode {
  name: string;
  detail?: string;
  kind: 'function' | 'variable' | 'namespace' | 'field' | 'package' | 'class';
  range: Span;
  selection: Span;
  children: OutlineNode[];
}

export function outlineOf(text: string): OutlineNode[] {
  const model = buildModel(text);
  const out: OutlineNode[] = [];
  const leaf = (name: string, kind: OutlineNode['kind'], key: Span, range: Span, detail?: string, children: OutlineNode[] = []): OutlineNode => ({ name, kind, detail, selection: key, range, children });
  if (model.imports.size) {
    const first = [...model.imports.values()][0].key;
    out.push(leaf('import', 'package', first, model.importSpan ?? first, undefined, [...model.imports].map(([a, dcl]) => leaf(a, 'package', dcl.key, { start: dcl.key.start, end: dcl.valueSpan.end }, dcl.path?.text))));
  }
  if (model.local?.path) out.push(leaf('local', 'package', model.local.key, { start: model.local.key.start, end: model.local.valueSpan.end }, model.local.path.text));
  if (model.plugins.length) {
    out.push(leaf('plugins', 'namespace', model.plugins[0].key, model.pluginsSpan ?? model.plugins[0].key, undefined, model.plugins.map((p) => leaf(p.name, 'class', p.key, p.pair, p.className?.text))));
  }
  for (const t of model.top) {
    const e = model.entries.filter((x) => x.top === t.name).sort((a, b) => a.map.start - b.map.start)[0];
    const direct = !!e && /^\s*:\s*$/.test(text.slice(t.key.end, e.map.start));
    const kids = t.argNames.map((a) => leaf(a.name, 'field', a.key, { start: a.key.start, end: Math.max(a.valueEnd, a.key.end) }));
    out.push(leaf(t.name, direct ? 'function' : 'variable', t.key, t.pair, direct ? `${e!.module.text}.${e!.source.text}` : undefined, kids));
  }
  return out;
}

export { offsetAt, TopKey };
