// Minimal stand-in for the `vscode` module, enough to drive extension.ts in Node.
import * as fs from 'fs';
import * as p from 'path';

export class Position { constructor(public line: number, public character: number) {} }
export class Range {
  start: Position; end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === 'number') { this.start = new Position(a, b as number); this.end = new Position(c!, d!); }
    else { this.start = a; this.end = b as Position; }
  }
  union(o: Range) { return new Range(this.start, o.end); }
}
export class Uri {
  constructor(public fsPath: string, public scheme = 'file') {}
  static file(f: string) { return new Uri(f); }
  toString() { return 'file://' + this.fsPath; }
}
export class Location { constructor(public uri: Uri, public range: Range) {} }
export class MarkdownString { isTrusted = false; constructor(public value: string) {} }
export class SnippetString { constructor(public value: string) {} }
export class Hover { constructor(public contents: MarkdownString, public range?: Range) {} }
export class CompletionItem { detail?: string; documentation?: unknown; sortText?: string; range?: Range; insertText?: unknown; command?: unknown; constructor(public label: string, public kind?: number) {} }
export class Diagnostic { source?: string; code?: unknown; constructor(public range: Range, public message: string, public severity: number) {} }
export class DocumentLink { tooltip?: string; constructor(public range: Range, public target: Uri) {} }
export class DocumentSymbol { children: DocumentSymbol[] = []; constructor(public name: string, public detail: string, public kind: number, public range: Range, public selectionRange: Range) {} }
export class CodeAction { diagnostics?: Diagnostic[]; isPreferred?: boolean; edit?: WorkspaceEdit; command?: unknown; constructor(public title: string, public kind?: unknown) {} }
export class WorkspaceEdit {
  ops: { type: string; uri: Uri; range?: Range; text?: string }[] = [];
  replace(uri: Uri, range: Range, text: string) { this.ops.push({ type: 'replace', uri, range, text }); }
  createFile(uri: Uri) { this.ops.push({ type: 'create', uri }); }
}
export const CompletionItemKind = new Proxy({}, { get: (_t, k) => String(k) }) as Record<string, number>;
export const SymbolKind = new Proxy({}, { get: (_t, k) => String(k) }) as Record<string, number>;
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2 };
export const CodeActionKind = { QuickFix: 'quickfix' };

export class FakeDoc {
  version = 1; lineCount: number;
  constructor(public uri: Uri, public languageId: string, private text: string) { this.lineCount = text.split('\n').length; }
  getText(r?: Range) { if (!r) return this.text; return this.text.slice(this.offsetAt(r.start), this.offsetAt(r.end)); }
  offsetAt(pos: Position) { const ls = this.text.split('\n'); let o = 0; for (let i = 0; i < pos.line; i++) o += ls[i].length + 1; return o + pos.character; }
  positionAt(off: number) { const before = this.text.slice(0, off).split('\n'); return new Position(before.length - 1, before[before.length - 1].length); }
}

export const registry: Record<string, any[]> = {};
const reg = (n: string) => (...a: any[]) => { (registry[n] ||= []).push(a); return { dispose() {} }; };
export const diagnostics = new Map<string, Diagnostic[]>();
export const state = { docs: [] as FakeDoc[], config: {} as Record<string, unknown>, messages: [] as string[] };
const evt = () => (_cb: unknown) => ({ dispose() {} });

export const languages = {
  createDiagnosticCollection: () => ({ set: (u: Uri, d: Diagnostic[]) => diagnostics.set(u.toString(), d), delete: (u: Uri) => diagnostics.delete(u.toString()), dispose() {} }),
  registerCompletionItemProvider: reg('completion'), registerHoverProvider: reg('hover'), registerDefinitionProvider: reg('definition'),
  registerReferenceProvider: reg('references'), registerRenameProvider: reg('rename'), registerDocumentLinkProvider: reg('links'),
  registerDocumentSymbolProvider: reg('symbols'), registerCodeActionsProvider: reg('codeActions'),
};
export const workspace = {
  get textDocuments() { return state.docs; },
  workspaceFolders: [{ uri: Uri.file(p.resolve(__dirname, '..', 'examples')) }],
  getConfiguration: () => ({ get: (k: string, d?: unknown) => (k in state.config ? state.config[k] : d), update: async () => {} }),
  createFileSystemWatcher: () => ({ onDidChange: evt(), onDidCreate: evt(), onDidDelete: evt(), dispose() {} }),
  onDidOpenTextDocument: evt(), onDidChangeTextDocument: evt(), onDidSaveTextDocument: evt(), onDidCloseTextDocument: evt(), onDidChangeConfiguration: evt(),
  findFiles: async () => ['demo.kiz', 'shared.kiz'].map((f) => Uri.file(p.resolve(__dirname, '..', 'examples', f))),
};
export const window = {
  activeTextEditor: undefined as unknown,
  createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '' as unknown, command: '' }),
  onDidChangeActiveTextEditor: evt(), showWarningMessage: async (m: string) => { state.messages.push(m); return undefined; },
};
export const commands = { registerCommand: reg('command'), executeCommand: async () => undefined };
export const extensions = { getExtension: () => undefined };
void fs;
