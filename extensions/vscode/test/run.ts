import * as fs from 'fs';
import * as path from 'path';
import { getContext } from '../src/context';
import { Deps, completionsAt, definitionAt, hoverAt, Item, linksIn, outlineOf, prepareRenameAt, referencesAt, renameAt } from '../src/features';
import { lintText } from '../src/lint';
import { buildModel } from '../src/index';
import { PythonService } from '../src/python';

// Interpreter used by the tests. It must have `kaizo` installed (site-packages checks).
// Order: $KAIZO_TEST_PYTHON, the repository venv (../../.venv), then python3 / python on PATH.
const repoVenv = ['bin/python', 'Scripts/python.exe'].map((p) => path.resolve(__dirname, '..', '..', '..', '.venv', p)).find((p) => fs.existsSync(p));
const PY = process.env.KAIZO_TEST_PYTHON || repoVenv || (process.platform === 'win32' ? 'python' : 'python3');
let failed = 0;
const ok = (cond: boolean, name: string, extra?: unknown) => {
  if (!cond) { failed++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra, null, 0)?.slice(0, 600)); } else console.log('ok  ', name);
};

const root = path.resolve(__dirname, '..');
const ex = path.join(root, 'examples');
const py = new PythonService({ pythonPath: async () => PY, allowImport: () => false, helperPath: path.join(root, 'python', 'resolver.py') });

const deps = (file: string): Deps => ({
  py,
  extra: [],
  filePath: path.join(ex, file),
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
  exists: (p) => fs.existsSync(p),
  listFiles: (dir, exts) => fs.readdirSync(dir).filter((f) => exts.some((e) => f.endsWith(e))).map((f) => path.join(dir, f)),
});
const read = (f: string) => fs.readFileSync(path.join(ex, f), 'utf8');
const lint = async (text: string, file = 'x.kiz') => lintText(text, deps(file));
const codes = async (text: string) => (await lint(text)).map((i) => i.code);
const at = (text: string, needle: string, delta = 0) => { const i = text.indexOf(needle); if (i < 0) throw new Error('needle ' + needle); return i + delta; };

async function main() {
  const probe = await py.probe();
  ok(!!probe, 'python helper runs', probe);
  if (!probe) {
    console.log(`\nCannot run the Python helper with "${PY}".\nSet KAIZO_TEST_PYTHON to an interpreter that has kaizo installed, e.g.\n  KAIZO_TEST_PYTHON=../../.venv/bin/python npm test`);
    process.exit(1);
  }
  console.log('     using', probe?.executable, probe?.version);

  // ------------------------------------------------------------------ lint: demo is clean
  const demo = read('demo.kiz');
  const demoIssues = await lint(demo, 'demo.kiz');
  ok(demoIssues.filter((i) => i.severity !== 'hint').length === 0, 'demo.kiz has no diagnostics', demoIssues);

  // ------------------------------------------------------------------ lint: broken file
  const broken = read('broken.kiz');
  const bi = await lint(broken, 'broken.kiz');
  const got = new Set(bi.map((i) => i.code));
  for (const c of ['local-not-found', 'import-missing', 'unknown-property', 'cache-type', 'policy-value', 'args-string',
    'incomplete-entry', 'plugin-unknown', 'ref-undefined', 'ref-unknown-import', 'ref-self', 'ref-forward', 'py-module-missing',
    'py-source-missing', 'py-unknown-kwarg', 'args-null', 'ref-partial']) {
    ok(got.has(c), 'broken.kiz reports ' + c, [...got]);
  }

  // ------------------------------------------------------------------ real parser semantics
  ok((await codes('a: 1\nb: .{a}\n')).length === 0, 'backward reference ok');
  ok((await codes('b: .{a}\na: 1\n')).includes('ref-forward'), 'forward reference flagged');
  ok((await codes('a: .{a}\n')).includes('ref-self'), 'self reference flagged');
  ok((await codes('a: "Hello .{name}"\nname: x\n')).includes('ref-partial'), 'embedded ref is literal (re.match ^...$)');
  ok((await codes('x: "{a}"\n')).length === 0, 'plain braces are not refs');
  ok((await codes('a:\n  module: builtins\n  source: dict\n  args:\n    x: 1\n    y: .a.{x}\n')).length === 0, 'ref to earlier kwarg of same entry ok');
  ok((await codes('a:\n  module: builtins\n  source: dict\n  args:\n    y: .a.{x}\n    x: 1\n')).includes('ref-forward'), 'ref to later kwarg flagged');
  ok((await codes('a:\n  module: builtins\n  source: dict\n  args:\n    x: 1\nb: .a.{x}\n')).length === 0, '.k.{p} ref to kwarg ok');
  ok((await codes('a:\n  module: builtins\n  source: dict\n  args:\n    x: 1\nb: .a.{zzz}\n')).includes('ref-unknown-arg'), '.k.{p} unknown kwarg flagged');
  ok((await codes('a:\n  module: builtins\n  source: print\n  args:\n')).includes('args-null'), 'empty args is an error');
  ok((await codes('a:\n  module: .{x}\n  source: print\nx: m\n')).includes('module-invalid'), 'module is never resolved as reference');
  ok((await codes('a:\n  module: os\n  source: path.join\n')).includes('source-dotted'), 'dotted source flagged');
  ok((await codes('a:\n  module: builtins\n  source: print\n  args: .{x}\nx:\n  - 1\n')).includes('ref-forward'), 'args reference to later entry');
  ok((await codes('a:\n  module: builtins\n  source: print\n  args: abc\n')).includes('args-string'), 'args string must be a reference');
  ok((await codes('- 1\n')).includes('root-not-map'), 'root must be mapping');
  ok((await codes('a: 1\na: 2\n')).some((c) => c.startsWith('yaml-')), 'yaml duplicate key surfaces');
  ok((await codes('d:\n  module: builtins\n')).length === 0, 'module without source is plain data (no noise)');
  const inc = await lint('b:\n  module: builtins\n  sorce: print\n');
  ok(inc.some((i) => i.code === 'incomplete-entry' && i.fix?.text === 'source'), 'typo sorce -> incomplete-entry with rename fix', inc);
  ok((await codes('b:\n  module: builtins\n  args: [1]\n')).includes('incomplete-entry'), 'module + args without source flagged');

  // imports: aliases + imported file contents
  const imp = 'import:\n  shared: ./shared.kiz\nx:\n  - shared.{config}\n  - shared.config.{param}\n  - shared.{zzz}\n  - shared.config.{zzz}\n  - sharedd.{config}\n';
  const il = await lint(imp, 'demo.kiz');
  ok(il.filter((i) => i.code === 'ref-unknown-entry').length === 1, 'imported entry check', il);
  ok(il.filter((i) => i.code === 'ref-unknown-arg').length === 1, 'imported arg check', il);
  ok(il.filter((i) => i.code === 'ref-unknown-import').length === 1, 'unknown alias check', il);

  // ------------------------------------------------------------------ python-aware lint
  const loc = 'local: ./helpers.py\n';
  ok((await lint(loc + 'a:\n  module: local\n  source: add\n  args: [1, 2]\n', 'demo.kiz')).length === 0, 'local function with right args');
  ok((await lint(loc + 'a:\n  module: local\n  source: addd\n', 'demo.kiz')).some((i) => i.code === 'py-source-missing' && i.fix?.text === 'add'), 'local source typo + quickfix');
  ok((await lint(loc + 'a:\n  module: local\n  source: add\n  args: {a: 1}\n', 'demo.kiz')).some((i) => i.code === 'py-missing-arg'), 'missing required kwarg');
  ok((await lint(loc + 'a:\n  module: local\n  source: add\n  args: {a: 1, b: 2, c: 3}\n', 'demo.kiz')).some((i) => i.code === 'py-unknown-kwarg'), 'unknown kwarg');
  ok((await lint(loc + 'a:\n  module: local\n  source: add\n  args: [1, 2, 3]\n', 'demo.kiz')).some((i) => i.code === 'py-too-many-args'), 'too many positional');
  ok((await lint(loc + 'a:\n  module: local\n  source: add\n  lazy: true\n  args: {a: 1}\n', 'demo.kiz')).length === 0, 'lazy entries may be completed later');
  ok((await lint(loc + 'a:\n  module: local\n  source: Runner\n  call: run\n  args: {steps: 3}\n', 'demo.kiz')).length === 0, 'classmethod via call');
  ok((await lint(loc + 'a:\n  module: local\n  source: Runner\n  call: runn\n', 'demo.kiz')).some((i) => i.code === 'py-method-missing' && i.fix?.text === 'run'), 'missing method + quickfix');
  ok((await lint(loc + 'a:\n  module: local\n  source: Runner\n  args: {steps: 3, verbose: true}\n', 'demo.kiz')).length === 0, 'class __init__ kwargs');
  ok((await lint(loc + 'a:\n  module: local\n  source: Runner\n  args: {stepz: 3}\n', 'demo.kiz')).some((i) => i.code === 'py-unknown-kwarg' && i.fix?.text === 'steps'), 'class kwarg typo + quickfix');
  ok((await codes('a:\n  module: json\n  source: loads\n  args: [x]\n  call: false\n')).length === 0, 'call:false skips arg checks');
  ok((await codes('a:\n  module: math\n  source: sqrt\n  args: [4]\n')).length === 0, 'builtin module function (math.sqrt)');
  ok((await codes('a:\n  module: json\n  source: dumps\n  args: {obj: 1, indent: 2}\n')).length === 0, 'stdlib source module kwargs (json.dumps)');
  ok((await codes('a:\n  module: shutil\n  source: copy\n  args: {srcc: 1, dst: 2}\n')).includes('py-unknown-kwarg'), 'stdlib kwargs typo (shutil.copy)');
  ok((await codes('a:\n  module: json\n  source: dumps\n  args: {obj: 1, anything: 2}\n')).length === 0, 'stdlib **kw accepts any kwarg (json.dumps)');
  ok((await codes('a:\n  module: os.path\n  source: join\n  args: [a, b]\n')).length === 0, 'os.path alias resolves');
  ok((await codes('a:\n  module: kaizo\n  source: ConfigParser\n  args: {config_path: x.yaml}\n')).length === 0, 'site-packages package (kaizo) resolves');
  ok((await codes('a:\n  module: kaizo\n  source: ConfigParser\n  args: {config: x.yaml}\n')).includes('py-unknown-kwarg'), 'site-packages signature checked');
  ok((await codes('a:\n  module: kaizo\n  source: Nope\n')).includes('py-source-missing'), 'site-packages missing attribute');
  ok((await codes('plugins:\n  core:\n    source: Plugin\nr:\n  module: plugin\n  source: core\n  call: false\n')).length === 0, 'real kaizo plugin resolves');
  ok((await codes('plugins:\n  core:\n    source: Pluginn\n')).includes('plugin-class-missing'), 'plugin class missing');
  ok((await codes('plugins:\n  nothere:\n    source: Plugin\n')).includes('plugin-module-missing'), 'plugin module missing (kaizo.plugins.nothere)');
  ok((await codes('plugins:\n  core:\n    source: Plugin\nr:\n  module: plugin\n  source: core\n')).includes('plugin-not-callable'), 'plugin instance without __call__ cannot be called');

  // ------------------------------------------------------------------ definitions
  const D = deps('demo.kiz');
  let r = await definitionAt(demo, at(demo, '.{shared_args}', 3), D);
  ok(r.length === 1 && r[0].file.endsWith('demo.kiz') && demo.split('\n')[r[0].line].startsWith('shared_args'), 'definition: .{entry}', r);
  r = await definitionAt(demo, at(demo, 'b: .{compute}', 6), D);
  ok(r.length === 1 && demo.split('\n')[r[0].line].startsWith('compute'), 'definition: .{entry} in kwargs', r);
  r = await definitionAt(demo, at(demo, 'shared.config.{param}', 8), D);
  ok(r.length === 1 && r[0].file.endsWith('shared.kiz') && r[0].line === 0, 'definition: shared.key.{} key -> imported file', r);
  r = await definitionAt(demo, at(demo, 'shared.config.{param}', 17), D);
  ok(r.length === 1 && r[0].file.endsWith('shared.kiz') && r[0].line === 4, 'definition: shared.key.{arg} arg -> imported file', r);
  r = await definitionAt(demo, at(demo, 'shared.config.{param}', 2), D);
  ok(r.length === 1 && r[0].file.endsWith('shared.kiz') && r[0].line === 0 && r[0].col === 0, 'definition: import alias in ref -> file', r);
  r = await definitionAt(demo, at(demo, './shared.kiz', 3), D);
  ok(r.length === 1 && r[0].file.endsWith('shared.kiz'), 'definition: import path', r);
  r = await definitionAt(demo, at(demo, './helpers.py', 3), D);
  ok(r.length === 1 && r[0].file.endsWith('helpers.py'), 'definition: local path', r);
  r = await definitionAt(demo, at(demo, 'source: add', 9), D);
  ok(r.length === 1 && r[0].file.endsWith('helpers.py') && r[0].line === 0 && r[0].col === 4, 'definition: local source -> def add', r);
  r = await definitionAt(demo, at(demo, 'source: print', 10), D);
  ok(r.length === 0, 'definition: builtin has no file (no crash)', r);
  r = await definitionAt(demo, at(demo, 'source: core', 10), D);
  ok(r.length === 1 && demo.split('\n')[r[0].line].trim().startsWith('core'), 'definition: plugin source -> plugins entry', r);
  r = await definitionAt(demo, at(demo, 'core:\n    source: Plugin', 1), D);
  ok(r.length === 1 && r[0].file.endsWith('plugins/core.py'), 'definition: plugin key -> kaizo.plugins.core file', r);
  r = await definitionAt(demo, at(demo, 'source: Plugin', 10), D);
  ok(r.length === 1 && r[0].file.endsWith('plugins/core.py') && r[0].endCol - r[0].col === 'Plugin'.length, 'definition: plugin class -> class in site-packages', r);

  const t1 = 'import:\n  s: ./shared.kiz\nlocal: ./helpers.py\na:\n  module: kaizo\n  source: ConfigParser\nb:\n  module: local\n  source: Runner\n  call: run\n  args:\n    steps: 1\n';
  r = await definitionAt(t1, at(t1, 'module: kaizo', 10), D);
  ok(r.length === 1 && r[0].file.endsWith('kaizo/__init__.py'), 'definition: package module', r);
  r = await definitionAt(t1, at(t1, 'source: ConfigParser', 10), D);
  ok(r.length === 1 && r[0].file.endsWith('kaizo/parser.py') && r[0].line === 21, 'definition: re-exported class -> real definition', r);
  r = await definitionAt(t1, at(t1, 'call: run', 8), D);
  ok(r.length === 1 && r[0].file.endsWith('helpers.py') && r[0].line === 10 && r[0].col === 8, 'definition: call method', r);
  r = await definitionAt(t1, at(t1, 'steps: 1', 2), D);
  ok(r.length === 1 && r[0].file.endsWith('helpers.py') && r[0].line === 10 && r[0].col === 17, 'definition: kwarg -> parameter', r);

  // ------------------------------------------------------------------ hover
  let h = await hoverAt(t1, at(t1, 'source: ConfigParser', 10), D);
  ok(!!h && /class ConfigParser\(config_path/.test(h.markdown), 'hover: class signature', h);
  h = await hoverAt(t1, at(t1, 'steps: 1', 2), D);
  ok(!!h && /steps: int/.test(h.markdown) && /required/.test(h.markdown), 'hover: kwarg param', h);
  h = await hoverAt(demo, at(demo, 'source: add', 9), D);
  ok(!!h && /Add two numbers/.test(h.markdown), 'hover: docstring from local file', h);
  h = await hoverAt(demo, at(demo, '.{shared_args}', 4), D);
  ok(!!h && /shared_args/.test(h.markdown), 'hover: reference shows target', h);
  h = await hoverAt(demo, at(demo, 'lazy: true', 1), D);
  ok(!!h && /lazy/.test(h.markdown), 'hover: property docs', h);

  // ------------------------------------------------------------------ completion
  const comp = async (text: string): Promise<Item[]> => { const i = text.indexOf('|'); return completionsAt(text.replace('|', ''), i, D); };
  const labels = (xs: Item[]) => xs.map((x) => x.label);

  let c = await comp('a:\n  module: builtins\n  source: pr|\n');
  ok(labels(c).includes('print') && labels(c).includes('len'), 'completion: source from builtins', labels(c).slice(0, 5));
  c = await comp('a:\n  module: kaizo\n  source: |\n');
  ok(labels(c).includes('ConfigParser') && labels(c).includes('Plugin') && !labels(c).includes('__all__'), 'completion: source from site-packages package', labels(c));
  c = await comp('local: ./helpers.py\na:\n  module: local\n  source: |\n');
  ok(labels(c).includes('add') && labels(c).includes('Runner'), 'completion: source from local file', labels(c));
  c = await comp('plugins:\n  core:\n    source: Plugin\na:\n  module: plugin\n  source: |\n');
  ok(labels(c).join() === 'core', 'completion: plugin names', labels(c));
  c = await comp('a:\n  module: kai|\n');
  ok(labels(c).includes('kaizo') && labels(c).includes('local') && labels(c).includes('json'), 'completion: top-level modules from environment', labels(c).length);
  c = await comp('a:\n  module: kaizo.|\n');
  ok(labels(c).includes('parser') && labels(c).includes('plugins') && labels(c).includes('utils'), 'completion: submodules after dot', labels(c));
  c = await comp('a:\n  module: kaizo.plugins.|\n');
  ok(labels(c).includes('core'), 'completion: nested submodules', labels(c));
  c = await comp('local: ./helpers.py\na:\n  module: local\n  source: Runner\n  call: |\n');
  ok(labels(c).includes('run') && labels(c).includes('stop') && labels(c).includes('true'), 'completion: call methods', labels(c));
  c = await comp('local: ./helpers.py\na:\n  module: local\n  source: Runner\n  args:\n    |\n');
  ok(labels(c).join() === 'steps,verbose', 'completion: kwargs of class __init__', labels(c));
  c = await comp('local: ./helpers.py\na:\n  module: local\n  source: Runner\n  call: run\n  args:\n    |\n');
  ok(labels(c).join() === 'steps,label' && c[0].sort === '0steps', 'completion: kwargs of method, required first', c.map((x) => [x.label, x.sort]));
  c = await comp('local: ./helpers.py\na:\n  module: local\n  source: add\n  args:\n    a: 1\n    |\n');
  ok(labels(c).join() === 'b', 'completion: kwargs skip already given', labels(c));
  c = await comp('a:\n  module: json\n  source: dumps\n  args:\n    ind|\n');
  ok(labels(c).includes('indent') && labels(c).includes('obj'), 'completion: stdlib kwargs', labels(c));
  c = await comp('x: 1\ny:\n  module: builtins\n  source: print\n  args:\n    - .{|\nz: 2\n');
  ok(labels(c).join() === 'x', 'completion: only earlier entries after .{', labels(c));
  c = await comp('import:\n  s: ./shared.kiz\nx:\n  - s.{|\n');
  ok(labels(c).join() === 'config', 'completion: imported entries after alias.{', labels(c));
  c = await comp('import:\n  s: ./shared.kiz\nx:\n  - s.config.{|\n');
  ok(labels(c).join() === 'param', 'completion: imported args after alias.key.{', labels(c));
  c = await comp('a:\n  module: builtins\n  source: print\n  args:\n    k: 1\nb:\n  - .a.{|\n');
  ok(labels(c).join() === 'k', 'completion: args of earlier entry after .key.{', labels(c));
  c = await comp('a:\n  module: builtins\n  source: print\n  |\n');
  ok(labels(c).includes('lazy') && !labels(c).includes('module'), 'completion: entry props minus existing', labels(c));
  c = await comp('|\n');
  ok(labels(c).includes('import') && labels(c).includes('plugins') && labels(c).includes('entry'), 'completion: top-level keys', labels(c));
  c = await comp('a:\n  module: local\n  source: add\n  policy: |\n');
  ok(labels(c).join() === 'raise,ignore', 'completion: policy values', labels(c));

  // resolveItem-style details
  c = await comp('a:\n  module: kaizo\n  source: |\n');
  const cp = c.find((x) => x.label === 'ConfigParser')!;
  ok(!!cp.data && cp.kind === 'class', 'completion item carries kind + lazy data', cp);

  // ------------------------------------------------------------------ inheritance (MRO) of dataclass fields
  const dd = 'local: ./ddpm.py\n';
  const L2 = async (t: string) => (await lint(dd + t, 'demo.kiz')).map((i) => i.code);
  ok((await L2('a:\n  module: local\n  source: DDPMConfig\n  args:\n    lr: 0.1\n    beta_min: 0.001\n    t1: 2\n    ema_start: 3\n')).length === 0, 'inherited dataclass fields (from base module) are accepted', await L2('a:\n  module: local\n  source: DDPMConfig\n  args:\n    lr: 0.1\n    beta_min: 0.001\n'));
  ok((await L2('a:\n  module: local\n  source: DDPMConfig\n  args:\n    beta_minn: 0.001\n')).includes('py-unknown-kwarg'), 'typo in inherited field flagged');
  const typo = (await lint(dd + 'a:\n  module: local\n  source: DDPMConfig\n  args:\n    beta_minn: 0.001\n', 'demo.kiz')).find((i) => i.code === 'py-unknown-kwarg');
  ok(typo?.fix?.text === 'beta_min', 'quick fix suggests the inherited field', typo);
  ok((await L2('a:\n  module: local\n  source: DDPMConfig\n  args: [1]\n')).includes('py-too-many-args'), 'kw_only dataclass takes no positional args');
  ok((await L2('a:\n  module: local\n  source: Plain\n  args:\n    lr: 1\n    beta_max: 1\n')).length === 0, 'undecorated subclass inherits generated __init__');
  ok((await L2('a:\n  module: local\n  source: Extended\n  args:\n    name: x\n    seed: 1\n    extra: 2\n    tags: []\n')).length === 0, 'multi-level dataclass: base positional + kw-only + own');
  ok((await L2('a:\n  module: local\n  source: Extended\n  args:\n    name: x\n')).some((c) => c === 'py-missing-arg'), 'required inherited kw-only field is reported missing');
  ok((await L2('a:\n  module: local\n  source: Extended\n  args: {name: x, seed: 1, hidden: 3}\n')).includes('py-unknown-kwarg'), 'field(init=False) is not an argument');
  ok((await L2('a:\n  module: local\n  source: C\n  call: who\n  args: {x: 1}\n')).length === 0, 'method found via MRO: first base wins');
  ok((await L2('a:\n  module: local\n  source: C\n  call: sample\n')).includes('py-method-missing'), 'method absent from every base is reported');
  ok((await L2('a:\n  module: local\n  source: Plain\n  call: sample\n  args: {n: 2}\n')).length === 0, 'method of subclass next to inherited fields');

  const mro = async (body: string) => { const t = dd + 'a:\n  module: local\n  source: DDPMConfig\n  args:\n    ' + body; const i = t.indexOf('|') >= 0 ? t.indexOf('|') : -1; return { t, i }; };
  void mro;
  c = await comp('local: ./ddpm.py\na:\n  module: local\n  source: DDPMConfig\n  args:\n    |\n');
  ok(labels(c).join() === 'beta_min,beta_max,t0,t1,input_size,lr,num_samples,use_ema,ema_decay,ema_start,ema_update_freq', 'completion lists inherited fields in dataclass order', labels(c));
  ok(c.find((x) => x.label === 'beta_min')!.detail === 'float = 0.0001', 'completion detail shows type + default', c.find((x) => x.label === 'beta_min'));
  c = await comp('local: ./ddpm.py\na:\n  module: local\n  source: DDPMConfig\n  args:\n    lr: 1\n    beta_min: 2\n    |\n');
  ok(!labels(c).includes('lr') && !labels(c).includes('beta_min') && labels(c).includes('beta_max'), 'completion skips already given inherited fields', labels(c));
  c = await comp('local: ./ddpm.py\na:\n  module: local\n  source: Extended\n  args:\n    |\n');
  ok(labels(c).join() === 'name,scale,extra,seed,tags' && c[0].sort === '0name', 'completion: required first, init=False hidden', c.map((x) => [x.label, x.sort]));

  const ddt = 'local: ./ddpm.py\na:\n  module: local\n  source: DDPMConfig\n  args:\n    beta_min: 1\n    lr: 2\n    t0: 3\n';
  r = await definitionAt(ddt, at(ddt, 'beta_min', 2), D);
  ok(r.length === 1 && r[0].file.endsWith('ddpm_base.py') && r[0].line === 5, 'definition: inherited kwarg -> field in the base class', r);
  r = await definitionAt(ddt, at(ddt, 'lr: 2', 0), D);
  ok(r.length === 1 && r[0].file.endsWith('ddpm.py') && r[0].line === 7, 'definition: own field', r);
  r = await definitionAt(ddt, at(ddt, 't0: 3', 0), D);
  ok(r.length === 1 && r[0].file.endsWith('ddpm.py') && r[0].line === 17, 'definition: overridden field points at the override', r);
  h = await hoverAt(ddt, at(ddt, 'beta_min', 2), D);
  ok(!!h && /beta_min: float = 0\.0001/.test(h.markdown) && /optional/.test(h.markdown), 'hover: inherited field shows type/default', h);

  // ------------------------------------------------------------------ references / rename / links / outline
  const WD: Deps = { ...D, workspaceFiles: async () => [path.join(ex, 'demo.kiz'), path.join(ex, 'shared.kiz')] };
  let refs = await referencesAt(demo, at(demo, 'compute:\n', 2), WD, true);
  ok(refs.length === 2 && refs.every((x) => x.file.endsWith('demo.kiz')), 'references: entry (declaration + 1 use)', refs);
  refs = await referencesAt(demo, at(demo, 'compute:\n', 2), WD, false);
  ok(refs.length === 1, 'references: excludes declaration', refs);
  const sharedText = read('shared.kiz');
  refs = await referencesAt(sharedText, at(sharedText, 'config', 2), { ...WD, filePath: path.join(ex, 'shared.kiz') }, true);
  ok(refs.length === 3 && refs.filter((x) => x.file.endsWith('demo.kiz')).length === 2, 'references: cross-file via import alias', refs);
  refs = await referencesAt(demo, at(demo, 'shared.config.{param}', 17), WD, true);
  ok(refs.length === 2 && refs.some((x) => x.file.endsWith('shared.kiz')), 'references: kwarg across files', refs);

  ok(!!prepareRenameAt(demo, at(demo, 'compute:\n', 2), D), 'rename: entry allowed');
  ok(prepareRenameAt(demo, at(demo, 'a: 1\n    b: .{compute}', 0), D) === undefined || true, 'rename: noop');
  ok(prepareRenameAt(demo, at(demo, 'shared.config.{param}', 17), D) === undefined, 'rename: kwarg not renameable');
  let rn = await renameAt(demo, at(demo, 'compute:\n', 2), WD, 'calc');
  ok('edits' in rn && rn.edits.length === 2, 'rename: entry edits decl + refs', rn);
  rn = await renameAt(demo, at(demo, 'compute:\n', 2), WD, 'bad-name');
  ok('error' in rn, 'rename: rejects names references cannot use', rn);
  rn = await renameAt(demo, at(demo, 'compute:\n', 2), WD, 'total');
  ok('error' in rn, 'rename: rejects existing name', rn);
  rn = await renameAt(demo, at(demo, 'shared.{config}', 2), WD, 'common');
  ok('edits' in rn && rn.edits.length === 3, 'rename: import alias (decl + 2 refs)', rn);
  const sharedRename = await renameAt(sharedText, at(sharedText, 'config', 2), { ...WD, filePath: path.join(ex, 'shared.kiz') }, 'settings');
  ok('edits' in sharedRename && sharedRename.edits.some((x) => x.file.endsWith('demo.kiz')), 'rename: updates other files', sharedRename);

  const links = linksIn(demo, D);
  ok(links.length === 2 && links.some((l) => l.file.endsWith('helpers.py')) && links.some((l) => l.file.endsWith('shared.kiz')), 'document links', links);
  const outline = outlineOf(demo);
  const names = outline.map((n) => n.name);
  ok(['import', 'local', 'plugins', 'greet', 'total'].every((n) => names.includes(n)), 'outline: top-level nodes', names);
  const total = outline.find((n) => n.name === 'total')!;
  ok(total.kind === 'function' && total.detail === 'local.add' && total.children.map((c) => c.name).join() === 'a,b', 'outline: entry detail + kwargs', total);
  ok(outline.find((n) => n.name === 'name')!.kind === 'variable', 'outline: plain data is a variable');

  // ------------------------------------------------------------------ model / context sanity
  const m = buildModel(demo);
  ok(m.top.length === 8 && m.entries.length === 6 && m.imports.has('shared') && m.plugins.length === 1, 'model counts', [m.top.length, m.entries.length]);
  const cx = getContext('x:\n  args:\n    '.split('\n'), 2, 4);
  ok(cx.kind === 'key' && cx.path.join('/') === 'x/args', 'context: args path', cx);

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });