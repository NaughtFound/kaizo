import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Issue } from './analyzer';
import { lintText } from './lint';
import {
  completionsAt, definitionAt, Deps, hoverAt, Item, linksIn, Loc, outlineOf, OutlineNode, prepareRenameAt, referencesAt, renameAt, resolveItem,
} from './features';
import { offsetAt, positionAt } from './index';
import { PythonService } from './python';

const SELECTOR: vscode.DocumentSelector = [{ language: 'kaizo' }, { language: 'yaml' }, { language: 'yml' }];

let service: PythonService;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let warnedNoPython = false;

const cfg = () => vscode.workspace.getConfiguration('kaizo');

/** `.kiz` files always count; plain YAML only when `# kaizo` is on one of the first lines. */
function isKaizo(doc: vscode.TextDocument): boolean {
  if (doc.languageId === 'kaizo') return true;
  if (doc.languageId !== 'yaml' && doc.languageId !== 'yml') return false;
  const head = doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 5), 0));
  return /^\s*#\s*kaizo\b/im.test(head);
}

// ---------------------------------------------------------------------------------------------
// Python interpreter
// ---------------------------------------------------------------------------------------------

function venvPython(folder: string): string | undefined {
  for (const v of ['.venv', 'venv', 'env', '.env']) {
    const p = process.platform === 'win32' ? path.join(folder, v, 'Scripts', 'python.exe') : path.join(folder, v, 'bin', 'python');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function msPythonPath(resource?: vscode.Uri): Promise<string | undefined> {
  try {
    const ext = vscode.extensions.getExtension('ms-python.python');
    if (!ext) return undefined;
    const api = ext.isActive ? ext.exports : await ext.activate();
    const p = api?.environments?.getActiveEnvironmentPath?.(resource);
    return p?.path as string | undefined;
  } catch {
    return undefined;
  }
}

async function resolvePythonPath(): Promise<string | undefined> {
  const configured = cfg().get<string>('python.path')?.trim();
  if (configured) return configured.replace('${workspaceFolder}', vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
  const resource = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const ms = await msPythonPath(resource);
  if (ms && fs.existsSync(ms)) return ms;
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const v = venvPython(f.uri.fsPath);
    if (v) return v;
  }
  return undefined; // service falls back to python3 / python
}

function extraSearchPaths(): string[] {
  const out: string[] = [];
  if (cfg().get<boolean>('python.includeWorkspaceFolders', true)) for (const f of vscode.workspace.workspaceFolders ?? []) out.push(f.uri.fsPath);
  for (const p of cfg().get<string[]>('python.extraPaths', [])) {
    out.push(p.replace('${workspaceFolder}', vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''));
  }
  return out;
}

function depsFor(doc: vscode.TextDocument): Deps {
  const readFile = (p: string) => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === p);
    if (open) return open.getText();
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    py: service,
    extra: extraSearchPaths(),
    filePath: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
    readFile,
    exists: (p) => fs.existsSync(p),
    listFiles: (dir, exts) => listFiles(dir, exts),
    workspaceFiles: async () => (await vscode.workspace.findFiles('**/*.kiz', '**/node_modules/**', 500)).map((u) => u.fsPath),
  };
}

function listFiles(dir: string, exts: string[], depth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__' || e.name === 'venv') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (level < depth) walk(full, level + 1);
      } else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// conversions
// ---------------------------------------------------------------------------------------------

const KINDS: Record<Item['kind'], vscode.CompletionItemKind> = {
  keyword: vscode.CompletionItemKind.Keyword,
  property: vscode.CompletionItemKind.Property,
  module: vscode.CompletionItemKind.Module,
  class: vscode.CompletionItemKind.Class,
  function: vscode.CompletionItemKind.Function,
  variable: vscode.CompletionItemKind.Variable,
  value: vscode.CompletionItemKind.Value,
  enum: vscode.CompletionItemKind.EnumMember,
  file: vscode.CompletionItemKind.File,
  snippet: vscode.CompletionItemKind.Snippet,
  reference: vscode.CompletionItemKind.Reference,
  method: vscode.CompletionItemKind.Method,
  field: vscode.CompletionItemKind.Field,
};

function toRange(doc: vscode.TextDocument, s: { start: number; end: number }) {
  return new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end));
}

const toLocation = (l: Loc) => new vscode.Location(vscode.Uri.file(l.file), new vscode.Range(l.line, l.col, l.endLine, l.endCol));

const md = (s: string) => {
  const m = new vscode.MarkdownString(s);
  m.isTrusted = false;
  return m;
};

// ---------------------------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------------------------

class Completion implements vscode.CompletionItemProvider {
  private lastDeps: Deps | undefined;

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    if (!isKaizo(doc)) return;
    const deps = (this.lastDeps = depsFor(doc));
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const items = await completionsAt(text, offset, deps);
    await noticePythonProblem();
    return items.map((it) => {
      const c = new vscode.CompletionItem(it.label, KINDS[it.kind]);
      c.detail = it.detail;
      if (it.doc) c.documentation = md(it.doc);
      c.sortText = it.sort;
      if (it.replace) c.range = toRange(doc, it.replace);
      if (it.insert !== undefined) c.insertText = it.snippet ? new vscode.SnippetString(it.insert) : it.insert;
      if (it.retrigger) c.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
      (c as vscode.CompletionItem & { _kz?: Item })._kz = it;
      return c;
    });
  }

  async resolveCompletionItem(c: vscode.CompletionItem) {
    const it = (c as vscode.CompletionItem & { _kz?: Item })._kz;
    if (!it?.data || !this.lastDeps) return c;
    const more = await resolveItem(it, this.lastDeps);
    if (more.detail) c.detail = more.detail;
    if (more.doc) c.documentation = md(more.doc);
    return c;
  }
}

class Hover implements vscode.HoverProvider {
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position) {
    if (!isKaizo(doc)) return;
    const r = await hoverAt(doc.getText(), doc.offsetAt(pos), depsFor(doc));
    return r ? new vscode.Hover(md(r.markdown), toRange(doc, r.span)) : undefined;
  }
}

class Definition implements vscode.DefinitionProvider {
  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position) {
    if (!isKaizo(doc)) return;
    const locs = await definitionAt(doc.getText(), doc.offsetAt(pos), depsFor(doc));
    return locs.map((l) => toLocation({ ...l, file: l.file || doc.uri.fsPath }));
  }
}

class References implements vscode.ReferenceProvider {
  async provideReferences(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.ReferenceContext) {
    if (!isKaizo(doc)) return;
    return (await referencesAt(doc.getText(), doc.offsetAt(pos), depsFor(doc), ctx.includeDeclaration)).map(toLocation);
  }
}

class Rename implements vscode.RenameProvider {
  prepareRename(doc: vscode.TextDocument, pos: vscode.Position) {
    if (!isKaizo(doc)) return;
    const r = prepareRenameAt(doc.getText(), doc.offsetAt(pos), depsFor(doc));
    if (!r) throw new Error('Only entry names and import aliases can be renamed.');
    return { range: toRange(doc, r.span), placeholder: r.name };
  }
  async provideRenameEdits(doc: vscode.TextDocument, pos: vscode.Position, newName: string) {
    const r = await renameAt(doc.getText(), doc.offsetAt(pos), depsFor(doc), newName);
    if ('error' in r) throw new Error(r.error);
    const edit = new vscode.WorkspaceEdit();
    for (const l of r.edits) edit.replace(vscode.Uri.file(l.file || doc.uri.fsPath), new vscode.Range(l.line, l.col, l.endLine, l.endCol), newName);
    return edit;
  }
}

class Links implements vscode.DocumentLinkProvider {
  provideDocumentLinks(doc: vscode.TextDocument) {
    if (!isKaizo(doc)) return;
    return linksIn(doc.getText(), depsFor(doc)).map((l) => {
      const link = new vscode.DocumentLink(toRange(doc, l.span), vscode.Uri.file(l.file));
      link.tooltip = 'Open file';
      return link;
    });
  }
}

const SYMBOL_KINDS: Record<OutlineNode['kind'], vscode.SymbolKind> = {
  function: vscode.SymbolKind.Function,
  variable: vscode.SymbolKind.Variable,
  namespace: vscode.SymbolKind.Namespace,
  field: vscode.SymbolKind.Field,
  package: vscode.SymbolKind.Package,
  class: vscode.SymbolKind.Class,
};

class Symbols implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(doc: vscode.TextDocument) {
    if (!isKaizo(doc)) return;
    const conv = (n: OutlineNode): vscode.DocumentSymbol => {
      const range = toRange(doc, n.range);
      const sel = toRange(doc, n.selection);
      const s = new vscode.DocumentSymbol(n.name, n.detail ?? '', SYMBOL_KINDS[n.kind], range.union(sel), sel);
      s.children = n.children.map(conv);
      return s;
    };
    return outlineOf(doc.getText()).map(conv);
  }
}

// ---------------------------------------------------------------------------------------------
// diagnostics + quick fixes
// ---------------------------------------------------------------------------------------------

const SEV: Record<Issue['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

const fixes = new Map<string, Map<string, Issue['fix']>>();
const lintSeq = new Map<string, number>();
const fixKey = (r: vscode.Range, code: string) => `${r.start.line}:${r.start.character}:${r.end.line}:${r.end.character}:${code}`;

async function lint(doc: vscode.TextDocument, coll: vscode.DiagnosticCollection) {
  const key = doc.uri.toString();
  if (!isKaizo(doc) || !cfg().get<boolean>('lint.enable', true)) {
    coll.delete(doc.uri);
    return;
  }
  const seq = (lintSeq.get(key) ?? 0) + 1;
  lintSeq.set(key, seq);
  const version = doc.version;
  const text = doc.getText();
  const issues = await lintText(text, depsFor(doc), { checkArgs: cfg().get<boolean>('lint.checkArguments', true) });
  if (lintSeq.get(key) !== seq || doc.version !== version) return; // a newer run is in flight
  const map = new Map<string, Issue['fix']>();
  coll.set(
    doc.uri,
    issues.map((i) => {
      const range = new vscode.Range(doc.positionAt(i.start), doc.positionAt(i.end));
      const d = new vscode.Diagnostic(range, i.message, SEV[i.severity]);
      d.source = 'kaizo';
      d.code = i.code;
      if (i.fix) map.set(fixKey(range, i.code), i.fix);
      return d;
    }),
  );
  fixes.set(key, map);
  await noticePythonProblem();
}

class Fixes implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, _r: vscode.Range, ctx: vscode.CodeActionContext) {
    const out: vscode.CodeAction[] = [];
    const map = fixes.get(doc.uri.toString());
    for (const d of ctx.diagnostics) {
      if (d.source !== 'kaizo') continue;
      const code = String(d.code);
      const f = map?.get(fixKey(d.range, code));
      if (f) {
        const a = new vscode.CodeAction(f.title, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.isPreferred = true;
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(doc.uri, new vscode.Range(doc.positionAt(f.start), doc.positionAt(f.end)), f.text);
        out.push(a);
      }
      if ((code === 'import-missing' || code === 'local-not-found') && doc.uri.scheme === 'file') {
        const rel = doc.getText(d.range);
        const target = vscode.Uri.file(path.resolve(path.dirname(doc.uri.fsPath), rel));
        const a = new vscode.CodeAction(`Create ${rel}`, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.edit = new vscode.WorkspaceEdit();
        a.edit.createFile(target, { ignoreIfExists: true });
        out.push(a);
      }
      if (code === 'py-module-missing' || code === 'py-kaizo-missing') {
        const a = new vscode.CodeAction('Select Python interpreter…', vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.command = { command: 'kaizo.selectInterpreter', title: 'Select Python interpreter' };
        out.push(a);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// interpreter UI
// ---------------------------------------------------------------------------------------------

async function noticePythonProblem() {
  if (service.available === false && !warnedNoPython) {
    warnedNoPython = true;
    output.appendLine(`Python helper failed: ${service.lastError ?? 'unknown error'}`);
    const pick = await vscode.window.showWarningMessage(
      'Kaizo: no usable Python interpreter was found, so imports cannot be resolved. Select one to enable module/package resolution.',
      'Select Interpreter',
    );
    if (pick) await vscode.commands.executeCommand('kaizo.selectInterpreter');
  }
}

async function refreshStatus() {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !isKaizo(doc)) {
    status.hide();
    return;
  }
  const env = service.env ?? (await service.probe());
  if (env) {
    status.text = `$(symbol-misc) Kaizo: Python ${env.version}`;
    status.tooltip = `${env.executable}\nClick to change the interpreter used to resolve imports`;
  } else {
    status.text = '$(warning) Kaizo: no Python';
    status.tooltip = 'Click to select a Python interpreter';
  }
  status.show();
}

async function reanalyzeAll(coll: vscode.DiagnosticCollection, clearCache = true) {
  if (clearCache) {
    service.invalidate();
    warnedNoPython = false;
  }
  for (const d of vscode.workspace.textDocuments) void lint(d, coll);
  await refreshStatus();
}

async function selectInterpreter(coll: vscode.DiagnosticCollection) {
  const items: (vscode.QuickPickItem & { path?: string; action?: string })[] = [];
  const seen = new Set<string>();
  const add = (label: string, p: string, description?: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      items.push({ label, description: description ?? p, detail: description ? p : undefined, path: p });
    }
  };
  items.push({ label: '$(sync) Automatic', description: 'Use the Python extension / workspace virtualenv / python3', action: 'auto' });
  try {
    const ext = vscode.extensions.getExtension('ms-python.python');
    if (ext) {
      const api = ext.isActive ? ext.exports : await ext.activate();
      for (const e of api?.environments?.known ?? []) {
        const p = e?.executable?.uri?.fsPath ?? e?.path;
        if (p) add(`$(python) ${e?.environment?.name ?? e?.version?.major ? 'Python ' + [e.version?.major, e.version?.minor].filter((x: unknown) => x !== undefined).join('.') : path.basename(path.dirname(path.dirname(p)))}`, p);
      }
    }
  } catch {
    /* optional */
  }
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const v = venvPython(f.uri.fsPath);
    if (v) add('$(folder) Workspace virtualenv', v);
  }
  items.push({ label: '$(folder-opened) Browse…', action: 'browse' }, { label: '$(edit) Enter path…', action: 'enter' });

  const pick = await vscode.window.showQuickPick(items, { title: 'Kaizo: Select Python interpreter', placeHolder: service.env?.executable });
  if (!pick) return;
  let chosen: string | undefined = pick.path;
  if (pick.action === 'auto') chosen = '';
  else if (pick.action === 'browse') {
    const u = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Select the python executable' });
    chosen = u?.[0]?.fsPath;
  } else if (pick.action === 'enter') chosen = await vscode.window.showInputBox({ prompt: 'Path or command of the Python interpreter', value: service.env?.executable });
  if (chosen === undefined) return;
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg().update('python.path', chosen, target);
  await reanalyzeAll(coll);
}

// ---------------------------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Kaizo');
  service = new PythonService({
    pythonPath: resolvePythonPath,
    allowImport: () => cfg().get<boolean>('python.allowImport', false),
    helperPath: path.join(context.extensionPath, 'python', 'resolver.py'),
  });
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'kaizo.selectInterpreter';

  const coll = vscode.languages.createDiagnosticCollection('kaizo');
  context.subscriptions.push(coll, output, status);

  const timers = new Map<string, NodeJS.Timeout>();
  const schedule = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => void lint(doc, coll), 300));
  };

  // python / kiz files changing on disk can change what imports resolve to
  let reTimer: NodeJS.Timeout | undefined;
  const reanalyzeSoon = () => {
    clearTimeout(reTimer);
    reTimer = setTimeout(() => void reanalyzeAll(coll), 600);
  };
  const pyWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
  const kizWatcher = vscode.workspace.createFileSystemWatcher('**/*.kiz');
  pyWatcher.onDidChange(reanalyzeSoon);
  pyWatcher.onDidCreate(reanalyzeSoon);
  pyWatcher.onDidDelete(reanalyzeSoon);
  kizWatcher.onDidChange(() => void reanalyzeAll(coll, false));
  kizWatcher.onDidCreate(() => void reanalyzeAll(coll, false));
  kizWatcher.onDidDelete(() => void reanalyzeAll(coll, false));

  // keep up with the Python extension's selected environment
  void (async () => {
    try {
      const ext = vscode.extensions.getExtension('ms-python.python');
      const api = ext ? (ext.isActive ? ext.exports : await ext.activate()) : undefined;
      api?.environments?.onDidChangeActiveEnvironmentPath?.(() => void reanalyzeAll(coll));
    } catch {
      /* optional */
    }
  })();

  vscode.workspace.textDocuments.forEach((d) => void lint(d, coll));
  void refreshStatus();

  const docSel = SELECTOR;
  context.subscriptions.push(
    pyWatcher,
    kizWatcher,
    vscode.workspace.onDidOpenTextDocument((d) => void lint(d, coll)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.languageId === 'python') reanalyzeSoon();
      else void lint(d, coll);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      coll.delete(d.uri);
      fixes.delete(d.uri.toString());
    }),
    vscode.window.onDidChangeActiveTextEditor(() => void refreshStatus()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kaizo')) void reanalyzeAll(coll);
    }),
    vscode.commands.registerCommand('kaizo.selectInterpreter', () => selectInterpreter(coll)),
    vscode.commands.registerCommand('kaizo.restartAnalysis', () => reanalyzeAll(coll)),
    vscode.languages.registerCompletionItemProvider(docSel, new Completion(), ':', ' ', '.', '{', '-'),
    vscode.languages.registerHoverProvider(docSel, new Hover()),
    vscode.languages.registerDefinitionProvider(docSel, new Definition()),
    vscode.languages.registerReferenceProvider(docSel, new References()),
    vscode.languages.registerRenameProvider(docSel, new Rename()),
    vscode.languages.registerDocumentLinkProvider(docSel, new Links()),
    vscode.languages.registerDocumentSymbolProvider(docSel, new Symbols()),
    vscode.languages.registerCodeActionsProvider(docSel, new Fixes(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );
  void offsetAt;
  void positionAt;
}

export function deactivate() {}
