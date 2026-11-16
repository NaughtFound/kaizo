import * as path from 'path';
import { analyze, Env, Issue, PyView } from './analyzer';
import { Deps, extraPaths } from './features';
import { buildModel } from './index';

/**
 * Runs the (synchronous) analyzer, loads whatever Python information it asked for,
 * and runs it again until nothing new is requested.
 */
export async function lintText(text: string, d: Deps, opts: { checkArgs?: boolean } = {}): Promise<Issue[]> {
  const dir = d.filePath ? path.dirname(d.filePath) : undefined;
  const model = buildModel(text);
  const extra = extraPaths(model, d);
  const py = d.py;
  let issues: Issue[] = [];

  for (let round = 0; round < 4; round++) {
    const needModules = new Set<string>();
    const needSymbols = new Map<string, { module: string; name: string }>();
    const view: PyView | undefined =
      py && py.available !== false
        ? {
            module(name) {
              const v = py.peekModule(name, extra);
              if (v === undefined) needModules.add(name);
              return v;
            },
            symbol(module, name) {
              const v = py.peekSymbol(module, name, extra);
              if (v === undefined) needSymbols.set(module + '::' + name, { module, name });
              return v;
            },
          }
        : undefined;

    const env: Env = {
      fileExists: (rel) => (dir ? d.exists(path.resolve(dir, rel)) : true),
      readImported: (rel) => (dir ? d.readFile(path.resolve(dir, rel)) : undefined),
      localModule: (rel) => {
        if (!dir) return undefined;
        const p = path.resolve(dir, rel);
        return d.exists(p) ? '@file:' + p : undefined;
      },
      py: view,
      checkArgs: opts.checkArgs,
    };
    issues = analyze(text, env);
    if (!py || (!needModules.size && !needSymbols.size)) break;
    await py.ensure({ modules: needModules, symbols: needSymbols.values() }, extra);
    if (py.available === false) {
      env.py = undefined;
      issues = analyze(text, { ...env, py: undefined });
      break;
    }
  }
  return issues;
}
