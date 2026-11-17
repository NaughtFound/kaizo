# Kaizo for VS Code

Language support for [Kaizo](https://github.com/NaughtFound/kaizo) declarative YAML configs.

`.kiz` files open as the *Kaizo* language. Plain `.yaml`/`.yml` files get the same features when
one of their first five lines is a `# kaizo` comment.

## Python package resolution

`module:` / `source:` are resolved against a real Python environment, like `import` would:

- interpreter: setting `kaizo.python.path` → the Python extension's selected environment → workspace `.venv`/`venv` → `python3`
  (status bar item / **Kaizo: Select Python Interpreter**)
- searched: that interpreter's `sys.path` (stdlib + site-packages), workspace folders, `kaizo.python.extraPaths`, and the folder of the `local:` file (kaizo adds it to `sys.path` too)
- **source (`.py`) modules are only parsed, never imported**, so third-party code is not executed. Re-exports (`from .parser import X`) and `*` imports are followed, and **inheritance is resolved like Python's MRO**: a `@dataclass` collects fields from all its base classes (across modules and packages, overrides keep their position, `kw_only`, `KW_ONLY`, `field(default=/default_factory=/init=False)` are honoured), `__init__` and methods are inherited with earlier bases winning. If a base class cannot be resolved, argument checks for that class are skipped instead of guessing.
  Built-in / stdlib C modules are imported (safe); compiled third-party modules only if `kaizo.python.allowImport` is on.

## Features

**Go to Definition** (F12 / Ctrl+click)
- `.{entry}`, `.entry.{kwarg}`, `alias.{entry}`, `alias.entry.{kwarg}` → the entry/kwarg, also in imported files
- `import:` / `local:` paths, import aliases → the file
- `module:` → the Python module file, `source:` → the class/function (through re-exports), `call:` → the method
- a key under `args:` → the parameter in the Python signature
- plugin entries → their `plugins:` declaration and the class in `kaizo.plugins.<name>`

**Completion**: modules and sub-modules from the environment, `source:` members, `call:` methods, **argument names from the signature** (required first), references (`.{`, `alias.{`, `.entry.{`), plugin names, files for `import:`/`local:`; signature + docstring on selection.

**Hover**: signatures and docstrings, parameter types/defaults, what a reference points at.

**Find references / Rename** for entry names and import aliases, across files that import each other. **Document links**, **outline** (entries with `module.source` and kwargs), **quick fixes** (did-you-mean, create missing file, select interpreter).

**Linting**, following what `kaizo/parser.py` really does:
- references must be the **whole string** (`.{x}`; text like `"hi .{x}"` is literal), entries resolve **top to bottom** so forward/self references fail, `.k.{p}` means *argument `p` of entry `k`*
- empty `args:` (kaizo raises TypeError), `module`/`source` are never reference-resolved, `source` can't contain dots
- unknown module / missing attribute / missing method, unknown or missing or too many arguments (skipped for `lazy`, `call: false`, `**kwargs`)
- plugins: `plugins.<name>` must exist as `kaizo.plugins.<name>`, class must exist, plugin instance must be callable (or use `call:`)
- missing `import`/`local` files, `module: local` without `local:`, unknown properties, `module` without `source` (typos like `sorce`), YAML errors

## Settings

| setting | default | |
|---|---|---|
| `kaizo.python.path` | `""` | interpreter (supports `${workspaceFolder}`) |
| `kaizo.python.extraPaths` | `[]` | extra import roots |
| `kaizo.python.includeWorkspaceFolders` | `true` | workspace folders are import roots |
| `kaizo.python.allowImport` | `false` | import compiled third-party modules to read members |
| `kaizo.lint.enable` / `kaizo.lint.checkArguments` | `true` | |

## Develop

```
npm install
npm test            # unit tests (needs a Python with kaizo: KAIZO_TEST_PYTHON=/path/to/python)
npm run test:smoke  # drives extension.ts against a mocked VS Code API
npm run package     # kaizo-vscode-*.vsix
```
F5 opens an Extension Host on `examples/` (`demo.kiz`, `broken.kiz`).
