// Kaizo language facts, taken from https://naughtfound.github.io/kaizo/
// (configuration, parser architecture, plugins, quickstart pages).

export interface PropDoc {
  name: string;
  detail: string;
  doc: string;
  values?: string[];
}

/** Properties of an executable entry (a mapping with both `module` and `source`). */
export const ENTRY_PROPS: PropDoc[] = [
  {
    name: 'module',
    detail: 'Python import path, `local` or `plugin`',
    doc:
      'Where Kaizo loads the object from.\n\n' +
      '- a Python import path such as `math` or `my.package`\n' +
      '- `local` – an object from the file given by the top-level `local:` key\n' +
      '- `plugin` – dispatch a plugin registered under `plugins:`\n\n' +
      'An entry is only executed when it has **both** `module` and `source`; otherwise it is treated as plain structured data.',
  },
  {
    name: 'source',
    detail: 'attribute name inside the module',
    doc:
      'The attribute to load from `module`: a function, a class, a method name (together with `call`) or, for `module: plugin`, the name of a registered plugin.\n\n' +
      'Kaizo raises an error while parsing if the attribute does not exist.',
  },
  {
    name: 'args',
    detail: 'list | mapping | .{reference}',
    doc:
      'Arguments passed to the loaded callable.\n\n' +
      '- **list** → positional arguments\n' +
      '- **mapping** → keyword arguments\n' +
      '- **string** → a reference such as `.{shared_args}` that must resolve to a list or mapping\n\n' +
      'Every value is itself resolvable and may reference other entries.',
  },
  {
    name: 'call',
    detail: 'true (default) | false | method name',
    values: ['true', 'false'],
    doc:
      'How the loaded object is executed.\n\n' +
      '- `true` *(default)* – call the object\n' +
      '- `false` – do not call it, return the raw object\n' +
      '- `"method_name"` – call that method on the loaded object (it must exist and be callable)',
  },
  {
    name: 'lazy',
    detail: 'true | false (default)',
    values: ['true', 'false'],
    doc: 'If `true` the entry is not executed immediately; accessing it returns a callable wrapper (`FnWithKwargs`) that can be executed later.',
  },
  {
    name: 'cache',
    detail: 'true (default) | false',
    values: ['true', 'false'],
    doc: 'If `true` *(default)* the result is cached per resolved argument set. Use `false` for non-deterministic callables (random values, timestamps).',
  },
  {
    name: 'policy',
    detail: 'raise (default) | ignore',
    values: ['raise', 'ignore'],
    doc: 'Exception handling during execution: `raise` *(default)* lets exceptions propagate, `ignore` suppresses them.',
  },
];

export const ENTRY_PROP_NAMES = new Set(ENTRY_PROPS.map((p) => p.name));
export const POLICY_VALUES = ['raise', 'ignore'];

/** Reserved top-level keys. */
export const TOP_LEVEL: PropDoc[] = [
  {
    name: 'import',
    detail: 'mapping: name → ./other.kiz',
    doc:
      'Imports other Kaizo configuration files. Each file is parsed with its own `ConfigParser` *before* the current file is resolved, and its entries are reachable by the import name:\n\n' +
      '```yaml\nimport:\n  shared: ./shared.yaml\n\ntask:\n  args:\n    value: shared.config.{param}\n```\n' +
      'Paths are relative to the current configuration file.',
  },
  {
    name: 'local',
    detail: 'path to a local Python file',
    doc: 'A local Python file whose objects become available through `module: local`. The file must exist and be a valid Python module, otherwise parsing fails.',
  },
  {
    name: 'plugins',
    detail: 'mapping: plugin name → class | {source, args}',
    doc:
      'Registers plugin dispatchers. Plugins subclass `Plugin` and live under `kaizo.plugins.<name>`; they are invoked with `module: plugin`.\n\n' +
      '```yaml\nplugins:\n  logger:\n    source: LoggerPlugin\n    args:\n      level: INFO\n```',
  },
  {
    name: 'isolated',
    detail: 'true (default) | false',
    values: ['true', 'false'],
    doc: 'Controls how this file is registered when imported. `true` *(default)*: local module of the importing parser. `false`: added to `shared_modules`, globally accessible to all parsers.',
  },
];
export const RESERVED_TOP = new Set(TOP_LEVEL.map((p) => p.name));

export const PLUGIN_PROPS: PropDoc[] = [
  { name: 'source', detail: 'plugin class name', doc: 'The `Plugin` subclass to load from `kaizo.plugins.<plugin name>`.' },
  { name: 'args', detail: 'constructor arguments', doc: 'Arguments passed to the plugin constructor when it is executed. They must be YAML-resolvable.' },
];

export const SPECIAL_MODULES: PropDoc[] = [
  { name: 'local', detail: 'object from the top-level `local:` file', doc: 'Load `source` from the Python file configured with the top-level `local` key.' },
  { name: 'plugin', detail: 'dispatch a registered plugin', doc: 'Dispatch the plugin named by `source` (registered under `plugins:`).' },
];

/** Frequently used modules, offered as `module:` completions. */
export const COMMON_MODULES = [
  'builtins', 'math', 'random', 'time', 'datetime', 'os', 'os.path', 'sys', 'json', 'pathlib', 'collections',
  'itertools', 'functools', 'logging', 'subprocess', 'shutil', 're', 'argparse', 'typing', 'copy', 'statistics',
];

/** A few well-known symbols per module, offered as `source:` completions. Not exhaustive. */
export const STDLIB: Record<string, string[]> = {
  builtins: [
    'print', 'len', 'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple', 'sum', 'min', 'max', 'abs', 'round',
    'sorted', 'range', 'open', 'enumerate', 'zip', 'map', 'filter', 'any', 'all', 'isinstance', 'type', 'repr', 'input',
  ],
  math: ['pi', 'e', 'sqrt', 'floor', 'ceil', 'sin', 'cos', 'tan', 'log', 'log2', 'log10', 'exp', 'pow', 'factorial', 'gcd'],
  random: ['random', 'randint', 'choice', 'choices', 'shuffle', 'seed', 'uniform', 'sample', 'gauss'],
  time: ['sleep', 'time', 'perf_counter', 'monotonic', 'strftime', 'time_ns'],
  datetime: ['datetime', 'date', 'timedelta', 'timezone'],
  os: ['getcwd', 'listdir', 'getenv', 'makedirs', 'remove', 'mkdir', 'system'],
  'os.path': ['join', 'exists', 'basename', 'dirname', 'abspath', 'isfile', 'isdir'],
  json: ['loads', 'dumps', 'load', 'dump'],
  pathlib: ['Path', 'PurePath'],
  collections: ['OrderedDict', 'Counter', 'defaultdict', 'deque', 'namedtuple'],
  functools: ['partial', 'reduce', 'lru_cache'],
  itertools: ['chain', 'product', 'permutations', 'combinations', 'count', 'cycle', 'repeat'],
  logging: ['getLogger', 'basicConfig', 'info', 'debug', 'warning', 'error'],
  subprocess: ['run', 'Popen', 'check_output'],
  shutil: ['copy', 'copytree', 'rmtree', 'move', 'which'],
  statistics: ['mean', 'median', 'stdev', 'variance', 'mode'],
};
