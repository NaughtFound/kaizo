import { spawn } from 'child_process';
import * as path from 'path';

export interface Param {
  name: string;
  kind: 'pos' | 'posonly' | 'kwonly' | 'varargs' | 'varkw';
  required: boolean;
  default: string | null;
  annotation: string | null;
  line?: number;
  col?: number;
  file?: string | null;
}

export interface MethodInfo {
  kind: 'method' | 'static' | 'class' | 'property' | 'attr';
  params: Param[] | null;
  line: number;
  col: number;
  file: string | null;
  doc: string | null;
}

export interface ModuleInfo {
  found: true;
  kind: string;
  file: string | null;
  isPackage: boolean;
  reliable: boolean;
  members: Record<string, string>;
  all: string[] | null;
}

export interface SymbolInfo {
  found: true;
  name: string;
  kind: 'class' | 'function' | 'var' | 'module' | 'unknown';
  module: string;
  file: string | null;
  line: number;
  col: number;
  doc: string | null;
  params: Param[] | null;
  sig: string | null;
  methods: Record<string, MethodInfo>;
  unresolved: string[];
  bases: string[];
  target?: string;
}

export interface ListEntry {
  name: string;
  pkg: boolean;
}

export interface PythonEnvInfo {
  version: string;
  executable: string;
  prefix: string;
}

export interface Settings {
  pythonPath(): Promise<string | undefined>;
  allowImport(): boolean;
  helperPath: string;
}

interface Resp {
  python: PythonEnvInfo;
  modules: Record<string, ModuleInfo | null>;
  symbols: Record<string, SymbolInfo | null>;
  lists: Record<string, ListEntry[]>;
}

/** Plain classes that behave like `object` when used as a base. */
export const KNOWN_BASES = new Set(['object', 'Plugin', 'ABC', 'Generic', 'Protocol']);

/**
 * Talks to python/resolver.py. All lookups are cached; sync `peek*` accessors let the
 * (synchronous) analyzer use whatever is already known, and `ensure` fills in the rest.
 */
export class PythonService {
  available: boolean | undefined;
  env: PythonEnvInfo | undefined;
  lastError: string | undefined;

  private modules = new Map<string, ModuleInfo | null>();
  private symbols = new Map<string, SymbolInfo | null>();
  private lists = new Map<string, ListEntry[]>();
  private generation = 0;

  constructor(private settings: Settings) {}

  /** Forget everything (interpreter changed, .py file saved, ...). */
  invalidate() {
    this.modules.clear();
    this.symbols.clear();
    this.lists.clear();
    this.generation++;
  }

  private ns(extra: string[]) {
    return extra.join('\u0000') + '\u0001';
  }

  peekModule(name: string, extra: string[]): ModuleInfo | null | undefined {
    return this.modules.get(this.ns(extra) + name);
  }
  peekSymbol(module: string, name: string, extra: string[]): SymbolInfo | null | undefined {
    return this.symbols.get(this.ns(extra) + module + '::' + name);
  }
  peekList(prefix: string, extra: string[]): ListEntry[] | undefined {
    return this.lists.get(this.ns(extra) + prefix);
  }

  async ensure(
    req: { modules?: Iterable<string>; symbols?: Iterable<{ module: string; name: string }>; lists?: Iterable<string> },
    extra: string[],
  ): Promise<void> {
    const ns = this.ns(extra);
    const modules = [...new Set(req.modules ?? [])].filter((m) => !this.modules.has(ns + m));
    const symbolMap = new Map<string, { module: string; name: string }>();
    for (const s of req.symbols ?? []) {
      const k = s.module + '::' + s.name;
      if (!this.symbols.has(ns + k)) symbolMap.set(k, s);
    }
    const lists = [...new Set(req.lists ?? [])].filter((l) => !this.lists.has(ns + l));
    if (!modules.length && !symbolMap.size && !lists.length) return;

    const gen = this.generation;
    const resp = await this.run({ extra, allowImport: this.settings.allowImport(), modules, symbols: [...symbolMap.values()], lists });
    if (!resp || gen !== this.generation) return;
    for (const m of modules) this.modules.set(ns + m, resp.modules[m] ?? null);
    for (const [k] of symbolMap) this.symbols.set(ns + k, resp.symbols[k] ?? null);
    for (const l of lists) this.lists.set(ns + l, resp.lists[l] ?? []);
  }

  /** Query interpreter details (also tests that Python works). */
  async probe(): Promise<PythonEnvInfo | undefined> {
    const r = await this.run({ extra: [] });
    return r?.python;
  }

  private async run(req: object): Promise<Resp | undefined> {
    const py = (await this.settings.pythonPath()) ?? 'python3';
    const candidates = py === 'python3' ? ['python3', 'python'] : [py];
    for (const exe of candidates) {
      const r = await this.exec(exe, req);
      if (r) {
        this.available = true;
        this.env = r.python;
        this.lastError = undefined;
        return r;
      }
    }
    this.available = false;
    return undefined;
  }

  private exec(exe: string, req: object): Promise<Resp | undefined> {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      const finish = (v: Resp | undefined) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      };
      let child;
      try {
        child = spawn(exe, ['-I', this.settings.helperPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
        });
      } catch (e) {
        this.lastError = String(e);
        return finish(undefined);
      }
      const timer = setTimeout(() => {
        this.lastError = 'Python helper timed out';
        child.kill();
        finish(undefined);
      }, 20000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        this.lastError = `${exe}: ${e.message}`;
        finish(undefined);
      });
      child.on('close', () => {
        try {
          finish(JSON.parse(out));
        } catch {
          this.lastError = err.trim().split('\n').pop() || 'Python helper returned no data';
          finish(undefined);
        }
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(req));
    });
  }
}

/** Helper: does a class (symbol) have a given method/attribute? `undefined` = can't tell. */
export function hasMethod(sym: SymbolInfo, name: string): boolean | undefined {
  if (name in sym.methods) return true;
  if (sym.unresolved.some((b) => !KNOWN_BASES.has(b))) return undefined;
  if (sym.unresolved.includes('<compiled>')) return undefined;
  return false;
}

export function dirOfFile(p: string) {
  return path.dirname(p);
}
