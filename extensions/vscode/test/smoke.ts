import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from '../src/extension';
import * as mock from './vscode-mock';

let failed = 0;
const ok = (c: boolean, n: string, x?: unknown) => { if (!c) { failed++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } else console.log('ok  ', n); };
const ex = path.resolve(__dirname, '..', 'examples');
const mk = (f: string) => new mock.FakeDoc(mock.Uri.file(path.join(ex, f)), 'kaizo', fs.readFileSync(path.join(ex, f), 'utf8'));
const prov = (n: string) => mock.registry[n][0][1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const demo = mk('demo.kiz');
  const broken = mk('broken.kiz');
  mock.state.docs.push(demo, broken);
  mock.state.config['python.path'] = process.env.KAIZO_TEST_PYTHON || '/tmp/kzenv/bin/python';
  const ctx: any = { subscriptions: [], extensionPath: path.resolve(__dirname, '..') };
  activate(ctx as vscode.ExtensionContext);
  ok(['completion', 'hover', 'definition', 'references', 'rename', 'links', 'symbols', 'codeActions'].every((n) => mock.registry[n]?.length === 1), 'all providers registered', Object.keys(mock.registry));
  ok(!!mock.registry.command.find((c) => c[0] === 'kaizo.selectInterpreter'), 'interpreter command registered');

  // diagnostics are produced asynchronously on activation
  for (let i = 0; i < 100 && mock.diagnostics.size < 2; i++) await sleep(100);
  const dd = mock.diagnostics.get(demo.uri.toString()) ?? [];
  const bd = mock.diagnostics.get(broken.uri.toString()) ?? [];
  ok(dd.filter((d) => d.severity < 3).length === 0, 'demo.kiz: no diagnostics through the extension', dd.map((d) => d.message));
  ok(bd.length >= 15, 'broken.kiz: many diagnostics', bd.length);
  ok(bd.every((d) => d.source === 'kaizo' && d.range.start.line <= d.range.end.line), 'diagnostics well-formed');
  const typo = bd.find((d) => d.code === 'py-source-missing');
  ok(!!typo && broken.getText(typo.range) === 'sqroot', 'diagnostic range maps to source text', typo?.range);

  // quick fixes
  const fixesP = prov('codeActions');
  const acts = fixesP.provideCodeActions(broken, typo!.range, { diagnostics: [typo!] });
  ok(acts.length === 1 && acts[0].title === "Change to 'sqrt'" && acts[0].edit.ops[0].text === 'sqrt', 'quick fix: did-you-mean', acts.map((a: any) => a.title));
  const missing = bd.find((d) => d.code === 'local-not-found')!;
  const acts2 = fixesP.provideCodeActions(broken, missing.range, { diagnostics: [missing] });
  ok(acts2.some((a: any) => /Create .*missing\.py/.test(a.title)), 'quick fix: create missing file', acts2.map((a: any) => a.title));

  // completion
  const text = demo.getText();
  const off = text.indexOf('source: add') + 'source: '.length;
  const comp = await prov('completion').provideCompletionItems(demo, demo.positionAt(off));
  ok(comp.some((c: any) => c.label === 'add') && comp.some((c: any) => c.label === 'Runner'), 'completion provider returns local symbols', comp.map((c: any) => c.label));
  ok(comp[0].range instanceof mock.Range, 'completion has a range');
  const resolved = await prov('completion').resolveCompletionItem(comp.find((c: any) => c.label === 'add'));
  ok(/def add\(a, b\)/.test(String(resolved.documentation?.value)), 'completion resolve adds signature + docs', resolved.documentation);

  // hover / definition / references / rename
  const hov = await prov('hover').provideHover(demo, demo.positionAt(text.indexOf('source: add') + 10));
  ok(/Add two numbers/.test(hov.contents.value), 'hover provider');
  const def = await prov('definition').provideDefinition(demo, demo.positionAt(text.indexOf('.{compute}') + 4));
  ok(def.length === 1 && def[0].range.start.line === demo.positionAt(text.indexOf('compute:')).line, 'definition provider (same file)', def);
  const def2 = await prov('definition').provideDefinition(demo, demo.positionAt(text.indexOf('source: add') + 10));
  ok(def2[0].uri.fsPath.endsWith('helpers.py') && def2[0].range.start.line === 0, 'definition provider (python file)', def2);
  const refs = await prov('references').provideReferences(demo, demo.positionAt(text.indexOf('compute:') + 2), { includeDeclaration: true });
  ok(refs.length === 2, 'references provider', refs.length);
  const prep = prov('rename').prepareRename(demo, demo.positionAt(text.indexOf('compute:') + 2));
  ok(prep.placeholder === 'compute', 'prepareRename');
  const edit = await prov('rename').provideRenameEdits(demo, demo.positionAt(text.indexOf('compute:') + 2), 'calc');
  ok(edit.ops.length === 2 && edit.ops.every((o: any) => o.text === 'calc'), 'rename edits');
  let threw = false; try { prov('rename').prepareRename(demo, demo.positionAt(text.indexOf('lazy: true'))); } catch { threw = true; }
  ok(threw, 'prepareRename rejects non-renameable');

  // links + symbols
  const links = prov('links').provideDocumentLinks(demo);
  ok(links.length === 2 && demo.getText(links[0].range).startsWith('./'), 'document links', links.length);
  const syms = prov('symbols').provideDocumentSymbols(demo);
  ok(syms.some((s: any) => s.name === 'total' && s.detail === 'local.add' && s.children.length === 2), 'document symbols');

  // non-kaizo yaml is ignored unless it opts in
  const yaml = new mock.FakeDoc(mock.Uri.file('/tmp/other.yaml'), 'yaml', 'a:\n  module: nosuch\n  source: x\n');
  ok((await prov('hover').provideHover(yaml, new mock.Position(1, 4))) === undefined, 'plain yaml is ignored');
  const opted = new mock.FakeDoc(mock.Uri.file('/tmp/other2.yaml'), 'yaml', '# kaizo\na:\n  module: json\n  source: dumps\n');
  const hv = await prov('hover').provideHover(opted, new mock.Position(3, 12));
  ok(!!hv && /dumps/.test(hv.contents.value), 'yaml with `# kaizo` marker is enabled', hv);

  console.log(failed ? `\n${failed} FAILED` : '\nsmoke: all passed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
