import { buildModel, EntryUse, Model, PluginDecl, REF_FULL, Span } from './index';
import { ENTRY_PROPS, POLICY_VALUES } from './spec';
import { hasMethod, MethodInfo, ModuleInfo, Param, SymbolInfo } from './python';

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface Fix {
  title: string;
  start: number;
  end: number;
  text: string;
}
export interface Issue {
  start: number;
  end: number;
  message: string;
  severity: Severity;
  code: string;
  fix?: Fix;
}

export interface PyView {
  /** undefined = not loaded yet (the caller should load it and re-run), null = not found */
  module(name: string): ModuleInfo | null | undefined;
  symbol(module: string, name: string): SymbolInfo | null | undefined;
}

export interface Env {
  /** Does a path (relative to the file being analyzed) exist? */
  fileExists(relPath: string): boolean;
  /** Text of an imported .kiz file, by the path written in `import:`. */
  readImported?(relPath: string): string | undefined;
  /** Pseudo module name ("@file:/abs/x.py") for the top-level `local:` file, if it exists. */
  localModule?(relPath: string): string | undefined;
  py?: PyView;
  /** Check args against Python signatures. */
  checkArgs?: boolean;
}

const ENTRY_PROP_NAMES = new Set(ENTRY_PROPS.map((p) => p.name));
const MODULE_RE = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function closest(word: string, candidates: Iterable<string>, maxDist = 2): string | undefined {
  let best: string | undefined;
  let bestD = maxDist + 1;
  for (const c of candidates) {
    if (!c || c === word) continue;
    const d = levenshtein(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

const dym = (s?: string) => (s ? ` Did you mean \`${s}\`?` : '');

export function analyze(text: string, env: Env): Issue[] {
  const issues: Issue[] = [];
  const add = (s: Span | undefined, message: string, severity: Severity, code: string, fix?: Fix) => {
    if (!s) return;
    issues.push({ start: s.start, end: Math.max(s.end, s.start + 1), message, severity, code, fix });
  };
  const fixTo = (s: Span, text: string, title?: string): Fix => ({ title: title ?? `Change to '${text}'`, start: s.start, end: s.end, text });

  const model = buildModel(text);
  for (const e of model.parseErrors) issues.push({ start: e.start, end: e.end, message: e.message, severity: e.severity, code: e.code });
  if (!model.rootIsMap) {
    if (model.rootSpan) add(model.rootSpan, 'A Kaizo file must be a mapping of entries (key: value).', 'error', 'root-not-map');
    return issues.sort((a, b) => a.start - b.start);
  }

  const topByName = new Map(model.top.map((t) => [t.name, t]));
  const pluginByName = new Map(model.plugins.map((p) => [p.name, p]));
  const importedModels = new Map<string, Model | null>();
  const importedModel = (alias: string): Model | null => {
    if (importedModels.has(alias)) return importedModels.get(alias)!;
    const decl = model.imports.get(alias);
    const t = decl?.path ? env.readImported?.(decl.path.text) : undefined;
    const m = t === undefined ? null : buildModel(t);
    importedModels.set(alias, m);
    return m;
  };

  // ---- top-level declarations -----------------------------------------------------------------
  if (model.importShape === 'other') add(model.importSpan, '`import` must be a mapping of name: ./file.kiz (kaizo raises TypeError otherwise).', 'error', 'import-type');
  for (const [alias, decl] of model.imports) {
    if (!decl.path) add(decl.valueSpan, 'Import path must be a string.', 'error', 'import-path-type');
    else if (!env.fileExists(decl.path.text)) add(decl.path.span, `Imported file \`${decl.path.text}\` was not found (paths are relative to this file).`, 'warning', 'import-missing');
    if (!/^\w+$/.test(alias)) add(decl.key, `Import alias \`${alias}\` can never be referenced: references only allow letters, digits and underscore.`, 'info', 'import-alias-name');
  }

  if (model.local) {
    const l = model.local;
    if (!l.path) add(l.valueSpan, '`local` must be a path to a Python file.', 'error', 'local-type');
    else if (!env.fileExists(l.path.text)) add(l.path.span, `Local Python file \`${l.path.text}\` was not found (relative to this file).`, 'warning', 'local-not-found');
    else if (!l.path.text.endsWith('.py')) add(l.path.span, '`local` should point to a `.py` file.', 'warning', 'local-not-py');
  }
  if (model.isolated && !model.isolated.ok) add(model.isolated.value, '`isolated` should be `true` or `false`.', 'warning', 'isolated-type');

  if (model.pluginsShape === 'other') add(model.pluginsSpan, '`plugins` must be a mapping of plugin name → class or { source, args } (kaizo raises TypeError otherwise).', 'error', 'plugins-type');
  const kaizoInstalled = env.py?.module('kaizo');
  for (const p of model.plugins) checkPlugin(p);

  function checkPlugin(p: PluginDecl) {
    if (p.shape === 'other') {
      add(p.key, `Plugin \`${p.name}\` must be a class name or a mapping with \`source\`.`, 'error', 'plugin-type');
      return;
    }
    if (p.shape === 'map') {
      for (const f of p.props) {
        if (f.name !== 'source' && f.name !== 'args') {
          const s = closest(f.name, ['source', 'args']);
          add(f.key, `Unknown plugin property \`${f.name}\`.` + (s ? dym(s) : ' Allowed: source, args.'), 'warning', 'plugin-property', s ? fixTo(f.key, s) : undefined);
        }
      }
      if (!p.props.some((x) => x.name === 'source')) {
        add(p.key, `Plugin \`${p.name}\` needs a \`source\` (kaizo: "source is required for ${p.name} plugin").`, 'error', 'plugin-no-source');
        return;
      }
    }
    if (!p.className) {
      if (p.shape === 'map') add(p.pair, '`source` must be the Plugin class name.', 'error', 'plugin-source-type');
      return;
    }
    // python resolution: plugin key -> module kaizo.plugins.<key>, source -> class
    const py = env.py;
    if (!py || kaizoInstalled === undefined) return;
    if (kaizoInstalled === null) return; // reported once per file below
    const modName = `kaizo.plugins.${p.name}`;
    const mod = py.module(modName);
    if (mod === undefined) return;
    if (mod === null) {
      add(p.key, `Plugin module \`${modName}\` was not found: the plugin key must match a module under kaizo.plugins.`, 'error', 'plugin-module-missing');
      return;
    }
    const sym = py.symbol(modName, p.className.text);
    if (sym === undefined) return;
    if (sym === null) {
      if (mod.reliable) {
        const s = closest(p.className.text, Object.keys(mod.members).filter((k) => mod.members[k] === 'class'));
        add(p.className.span, `\`${modName}\` has no class \`${p.className.text}\`.` + dym(s), 'error', 'plugin-class-missing', s ? fixTo(p.className.span, s) : undefined);
      }
      return;
    }
    if (p.args && env.checkArgs !== false) {
      checkKwargs({ args: p.args, lazy: false, anchor: p.key }, sym.kind === 'class' ? sym.params : null);
    }
  }

  if (model.plugins.length && kaizoInstalled === null && model.pluginsShape === 'map') {
    add(model.pluginsSpan, 'The `kaizo` package was not found in the selected Python environment, so plugins cannot be resolved. Use "Kaizo: Select Python Interpreter".', 'info', 'py-kaizo-missing');
  }

  // ---- entries ---------------------------------------------------------------------------------
  for (const e of model.entries) checkEntry(e);

  function checkKwargs(
    ctx: { args?: EntryUse['args']; lazy: boolean | undefined; anchor: Span },
    params: Param[] | null | undefined,
  ) {
    if (!params || env.checkArgs === false) return;
    const a = ctx.args;
    const hasVarkw = params.some((p) => p.kind === 'varkw');
    const hasVarargs = params.some((p) => p.kind === 'varargs');
    const positional = params.filter((p) => p.kind === 'pos' || p.kind === 'posonly');
    if (a?.kind === 'map') {
      const names = params.filter((p) => p.kind !== 'varargs' && p.kind !== 'varkw' && p.kind !== 'posonly').map((p) => p.name);
      if (!hasVarkw) {
        for (const k of a.keys) {
          if (!names.includes(k.name)) {
            const s = closest(k.name, names);
            add(k.key, `Unexpected argument \`${k.name}\`.` + (s ? dym(s) : names.length ? ` Accepted: ${names.join(', ')}.` : ' This callable takes no arguments.'), 'warning', 'py-unknown-kwarg', s ? fixTo(k.key, s) : undefined);
          }
        }
      }
      if (!ctx.lazy) {
        const given = new Set(a.keys.map((k) => k.name));
        const missing = params.filter((p) => p.required && (p.kind === 'pos' || p.kind === 'kwonly') && !given.has(p.name)).map((p) => p.name);
        if (missing.length) add(a.key, `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`, 'warning', 'py-missing-arg');
      }
    } else if (a?.kind === 'list') {
      if (!hasVarargs && a.count > positional.length) {
        add(a.value, `Too many positional arguments: ${a.count} given, at most ${positional.length} accepted.`, 'warning', 'py-too-many-args');
      }
      if (!ctx.lazy) {
        const need = positional.filter((p) => p.required).length;
        if (a.count < need) add(a.key, `Expected at least ${need} positional argument${need > 1 ? 's' : ''}, got ${a.count}.`, 'warning', 'py-missing-arg');
      }
    } else if (!a) {
      if (!ctx.lazy) {
        const missing = params.filter((p) => p.required && (p.kind === 'pos' || p.kind === 'kwonly' || p.kind === 'posonly')).map((p) => p.name);
        if (missing.length) add(ctx.anchor, `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Add an \`args:\` section.`, 'warning', 'py-missing-arg');
      }
    }
  }

  function checkEntry(e: EntryUse) {
    // 1. unknown properties (parser ignores them silently, which is why they are easy to miss)
    for (const [k, v] of e.keys) {
      if (!ENTRY_PROP_NAMES.has(k)) {
        const s = closest(k, ENTRY_PROP_NAMES);
        add(v.key, `Unknown property \`${k}\` on an executable entry (it is ignored).` + (s ? dym(s) : ` Allowed: ${ENTRY_PROPS.map((p) => p.name).join(', ')}.`), 'warning', 'unknown-property', s ? fixTo(v.key, s) : undefined);
      }
    }

    // 2. simple value types
    for (const name of ['lazy', 'cache'] as const) {
      const p = e.keys.get(name);
      if (p && !/^(true|false)$/.test(text.slice(p.value.start, p.value.end).trim())) {
        add(p.value, `\`${name}\` should be \`true\` or \`false\`.`, 'warning', `${name}-type`);
      }
    }
    const pol = e.keys.get('policy');
    if (pol) {
      const raw = text.slice(pol.value.start, pol.value.end).trim().replace(/^["']|["']$/g, '');
      if (raw && !POLICY_VALUES.includes(raw)) {
        const s = closest(raw, POLICY_VALUES);
        add(pol.value, '`policy` must be `raise` or `ignore`.' + dym(s), 'error', 'policy-value', s ? fixTo(pol.value, s) : undefined);
      }
    }
    const callKey = e.keys.get('call');
    if (callKey && !e.call) add(callKey.value, '`call` must be `true`, `false` or a method name.', 'error', 'call-type');
    if (e.call?.value === false && e.lazy === true) add(e.keys.get('lazy')!.key, '`lazy: true` has no effect together with `call: false`.', 'hint', 'lazy-nocall');

    // 3. args shape (kaizo/parser.py::_resolve_args)
    const a = e.args;
    if (a) {
      if (a.kind === 'null') add(a.key, '`args` is empty: kaizo raises "invalid type for args, got NoneType". Remove it or give a list/mapping.', 'error', 'args-null');
      else if (a.kind === 'other') add(a.value, '`args` must be a list, a mapping or a reference string.', 'error', 'args-type');
      else if (a.kind === 'str' && a.str && !REF_FULL.test(a.str.text)) {
        add(a.str.span, '`args` given as a string must be exactly a reference such as `.{name}` that resolves to a list or mapping.', 'error', 'args-string');
      }
    }

    // 4. module / source
    const mod = e.module.text;
    const src = e.source.text;
    if (!mod) {
      add(e.module.span, '`module` must be a string.', 'error', 'module-type');
      return;
    }
    if (!src) {
      add(e.source.span, '`source` must be a string.', 'error', 'source-type');
      return;
    }

    let pyModule: string | undefined; // what to ask the Python helper for
    let isPlugin = false;
    if (mod === 'local') {
      if (!model.local) add(e.module.span, '`module: local` needs a top-level `local: ./file.py` entry ("local module is not given").', 'error', 'local-missing');
      else if (model.local.path) pyModule = env.localModule?.(model.local.path.text);
    } else if (mod === 'plugin') {
      isPlugin = true;
      if (!pluginByName.has(src)) {
        const s = closest(src, pluginByName.keys());
        add(e.source.span, `Plugin \`${src}\` is not registered under \`plugins:\`.` + dym(s), 'error', 'plugin-unknown', s ? fixTo(e.source.span, s) : undefined);
      }
    } else if (!MODULE_RE.test(mod)) {
      add(e.module.span, `\`${mod}\` is not a valid Python import path (\`module\` is used literally; references are not resolved here).`, 'error', 'module-invalid');
    } else pyModule = mod;

    if (!isPlugin && src.includes('.')) {
      add(e.source.span, '`source` must be a single attribute name; kaizo calls hasattr(module, source), so dotted names never match.', 'error', 'source-dotted');
      return;
    }

    const py = env.py;
    if (!py) return;

    // 5. python resolution
    let sym: SymbolInfo | null | undefined;
    if (isPlugin) {
      const decl = pluginByName.get(src);
      if (decl?.className && kaizoInstalled) {
        sym = py.symbol(`kaizo.plugins.${decl.name}`, decl.className.text);
      }
    } else if (pyModule) {
      const mi = py.module(pyModule);
      if (mi === undefined) return;
      if (mi === null) {
        if (mod !== 'local') add(e.module.span, `Module \`${mod}\` was not found in the selected Python environment.`, 'warning', 'py-module-missing');
        return;
      }
      if (mi.reliable && !(src in mi.members)) {
        const s = closest(src, Object.keys(mi.members).filter((k) => !k.startsWith('_')));
        add(e.source.span, `Module \`${mod === 'local' ? 'local' : mod}\` has no attribute \`${src}\` (kaizo raises AttributeError).` + dym(s), 'error', 'py-source-missing', s ? fixTo(e.source.span, s) : undefined);
        return;
      }
      sym = py.symbol(pyModule, src);
    }
    if (!sym) return;

    // 6. call semantics (kaizo/utils/entry.py::ModuleEntry)
    const call = e.call?.value;
    let params: Param[] | null | undefined;
    if (call === false) return;
    if (typeof call === 'string') {
      if (sym.kind !== 'class') return; // function attribute / variable: cannot know
      const has = hasMethod(sym, call);
      if (has === false && e.call) {
        const s = closest(call, Object.keys(sym.methods).filter((k) => !k.startsWith('_')));
        add(e.call.span, `\`${sym.name}\` has no method \`${call}\` (kaizo raises AttributeError).` + dym(s), 'error', 'py-method-missing', s ? fixTo(e.call.span, s) : undefined);
        return;
      }
      const m: MethodInfo | undefined = sym.methods[call];
      if (!m) return;
      // `Cls.method` is looked up on the class: plain methods stay unbound there (self not passed),
      // but plugins dispatch to an instance first.
      params = m.kind === 'method' && !isPlugin ? null : m.params;
    } else {
      if (sym.kind === 'module') {
        add(e.source.span, `\`${src}\` is a module, which is not callable; use \`call: false\` to get the object itself.`, 'error', 'call-not-callable');
        return;
      }
      if (isPlugin) {
        const callM = sym.methods['__call__'];
        if (!callM && hasMethod(sym, '__call__') === false) {
          add(e.source.span, `Plugin class \`${sym.name}\` has no \`__call__\`, but this entry calls the dispatched instance. Set \`call: <method>\` or \`call: false\`.`, 'warning', 'plugin-not-callable');
          return;
        }
        params = callM?.params ?? null;
      } else if (sym.kind === 'class' || sym.kind === 'function') params = sym.params;
    }
    checkKwargs({ args: e.args, lazy: e.lazy, anchor: e.keys.get('source')!.key }, params);
  }

  for (const inc of model.incomplete) {
    add(
      inc.presentKey,
      `\`${inc.present}\` without \`${inc.missing}\`: kaizo treats this mapping as plain data and will not execute it.` + (inc.near ? dym(inc.missing) : ''),
      'warning',
      'incomplete-entry',
      inc.near ? { title: `Rename '${inc.near.name}' to '${inc.missing}'`, start: inc.near.key.start, end: inc.near.key.end, text: inc.missing } : undefined,
    );
  }

  // ---- references --------------------------------------------------------------------------------
  const kwargHint = 'unless it is passed as a runtime kwarg';
  for (const r of model.refs) {
    if (r.kind === 'partial') {
      add(r.span, 'Kaizo only resolves a string that is exactly a reference (e.g. `.{name}`); in this string it is used literally.', 'info', 'ref-partial');
      continue;
    }
    const cur = r.top ? topByName.get(r.top) : undefined;
    const before = (t: { pair: Span }) => t.pair.end <= r.span.start;

    if (r.module) {
      // m.{x} or m.k.{p}  -> imported file
      if (!model.imports.has(r.module)) {
        const s = closest(r.module, model.imports.keys());
        add(r.moduleSpan, `Unknown import \`${r.module}\`.` + (s ? dym(s) : ' Declare it under `import:`.'), 'warning', 'ref-unknown-import', s ? fixTo(r.moduleSpan, s) : undefined);
        continue;
      }
      const im = importedModel(r.module);
      if (!im || !im.rootIsMap) continue;
      const targets = [...im.top, ...im.plugins.map((p) => ({ name: p.name, argNames: p.argNames }))];
      if (r.key === undefined) {
        if (!im.top.some((t) => t.name === r.sub)) {
          const s = closest(r.sub, im.top.map((t) => t.name));
          add(r.subSpan.end > r.subSpan.start ? r.subSpan : r.span, `\`${r.module}\` has no entry \`${r.sub}\`.` + dym(s), 'warning', 'ref-unknown-entry', s ? fixTo(r.subSpan, s) : undefined);
        }
      } else {
        const t = targets.find((x) => x.name === r.key);
        if (!t) {
          const s = closest(r.key, targets.map((x) => x.name));
          add(r.keySpan, `\`${r.module}\` has no entry \`${r.key}\`.` + dym(s), 'warning', 'ref-unknown-entry', s && r.keySpan ? fixTo(r.keySpan, s) : undefined);
        } else if (!t.argNames.some((a) => a.name === r.sub)) {
          const s = closest(r.sub, t.argNames.map((a) => a.name));
          add(r.subSpan, `Entry \`${r.key}\` of \`${r.module}\` has no argument \`${r.sub}\`.` + dym(s), 'warning', 'ref-unknown-arg', s ? fixTo(r.subSpan, s) : undefined);
        }
      }
      continue;
    }

    // local scope
    if (r.key === undefined) {
      if (r.sub === '') {
        add(r.span, 'Empty reference `.{}` always fails: it resolves to the entry being defined.', 'error', 'ref-empty');
        continue;
      }
      const t = topByName.get(r.sub);
      if (t && r.top === r.sub) {
        add(r.subSpan, `Entry \`${r.sub}\` references itself; its value does not exist until it has been resolved.`, 'error', 'ref-self');
      } else if (t && !before(t)) {
        add(r.subSpan, `\`${r.sub}\` is defined later in the file. Entries resolve top to bottom, so this fails ${kwargHint}.`, 'warning', 'ref-forward');
      } else if (!t) {
        const s = closest(r.sub, topByName.keys());
        add(r.subSpan, `\`${r.sub}\` is not an entry in this file; it must be passed as a runtime kwarg.` + dym(s), s ? 'warning' : 'info', 'ref-undefined', s ? fixTo(r.subSpan, s) : undefined);
      }
      continue;
    }

    // `.k.{p}`: p is a *named argument* of entry k
    const k = r.key;
    const t = topByName.get(k) ?? pluginByName.get(k);
    if (!t) {
      const s = closest(k, topByName.keys());
      add(r.keySpan, `\`${k}\` is not an entry in this file.` + dym(s), 'warning', 'ref-unknown-entry', s && r.keySpan ? fixTo(r.keySpan, s) : undefined);
      continue;
    }
    const argNames = 'argNames' in t ? t.argNames : [];
    const arg = argNames.find((a) => a.name === r.sub);
    if (cur && cur.name === k) {
      if (!arg || arg.valueEnd > r.span.start) {
        const s = closest(r.sub, argNames.map((a) => a.name));
        add(r.subSpan, arg ? `Argument \`${r.sub}\` is defined after this reference; arguments resolve in order.` : `Entry \`${k}\` has no argument \`${r.sub}\` defined before this point.` + dym(s), 'warning', arg ? 'ref-forward' : 'ref-unknown-arg', !arg && s ? fixTo(r.subSpan, s) : undefined);
      }
    } else {
      const tt = topByName.get(k);
      if (tt && !before(tt)) {
        add(r.keySpan, `\`${k}\` is defined later in the file. Entries resolve top to bottom, so this fails ${kwargHint}.`, 'warning', 'ref-forward');
      } else if (!arg) {
        const s = closest(r.sub, argNames.map((a) => a.name));
        add(r.subSpan, `Entry \`${k}\` has no argument \`${r.sub}\`.` + dym(s), 'warning', 'ref-unknown-arg', s ? fixTo(r.subSpan, s) : undefined);
      }
    }
  }

  return issues.sort((a, b) => a.start - b.start);
}
