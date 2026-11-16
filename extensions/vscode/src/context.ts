// Indentation-based context detection. Works on incomplete YAML (which is what
// you have while typing), so it does not depend on the YAML parser.

export type Context =
  | { kind: 'reference'; prefix: string; typed: string }
  | { kind: 'value'; key: string; path: string[]; siblings: Map<string, string>; typed: string }
  | { kind: 'key'; path: string[]; siblings: Map<string, string>; typed: string; parent?: Map<string, string> }
  | { kind: 'none' };

const KEY_RE = /^(\s*)((?:-\s+)*)([A-Za-z_][\w.-]*)\s*:(?:\s+(.*)|\s*)$/;

interface KeyLine {
  line: number;
  keyCol: number;
  dash: boolean;
  key: string;
  value: string;
}

function parseKeyLine(text: string, line: number): KeyLine | undefined {
  const m = KEY_RE.exec(text);
  if (!m) return undefined;
  const dashes = m[2];
  return { line, keyCol: m[1].length + dashes.length, dash: dashes.length > 0, key: m[3], value: (m[4] ?? '').replace(/\s+#.*$/, '').trim() };
}

function isBlankOrComment(t: string) {
  return /^\s*(#.*)?$/.test(t);
}

/** Keys that are siblings of the mapping the cursor is in, plus the ancestor key path. */
function mappingInfo(lines: string[], line: number, col: number) {
  const siblings = new Map<string, string>();
  const path: string[] = [];
  let ancestor: { line: number; col: number } | undefined;

  // Determine column of the key we are editing.
  const cur = lines[line];
  const dashM = /^(\s*)((?:-\s+)*)/.exec(cur)!;
  const keyCol = dashM[1].length + dashM[2].length || Math.min(col, cur.length);
  const curIsDash = dashM[2].length > 0;

  // siblings upward
  let startedByDash = curIsDash;
  if (!curIsDash) {
    for (let i = line - 1; i >= 0; i--) {
      const t = lines[i];
      if (isBlankOrComment(t)) continue;
      const kl = parseKeyLine(t, i);
      const indent = /^\s*/.exec(t)![0].length;
      if (kl && kl.keyCol === keyCol) {
        siblings.set(kl.key, kl.value);
        if (kl.dash) break;
      } else if (kl && kl.keyCol < keyCol) break;
      else if (!kl && indent < keyCol && !/^\s*-\s/.test(t)) break;
      else if (!kl && /^\s*-\s/.test(t) && indent + 2 <= keyCol && indent + 2 >= keyCol) break;
    }
  }
  // siblings downward
  for (let i = line + 1; i < lines.length; i++) {
    const t = lines[i];
    if (isBlankOrComment(t)) continue;
    const indent = /^\s*/.exec(t)![0].length;
    const kl = parseKeyLine(t, i);
    if (kl && kl.dash && kl.keyCol >= keyCol && indent < keyCol) break; // next list item
    if (kl && kl.keyCol === keyCol && !kl.dash) siblings.set(kl.key, kl.value);
    else if (indent < keyCol) break;
  }

  // ancestors
  let curIndent = keyCol;
  for (let i = line - 1; i >= 0; i--) {
    const kl = parseKeyLine(lines[i], i);
    if (!kl) continue;
    if (kl.keyCol < curIndent) {
      if (!ancestor) ancestor = { line: kl.line, col: kl.keyCol };
      path.unshift(kl.key);
      curIndent = kl.keyCol;
      if (curIndent === 0) break;
    }
  }
  void startedByDash;
  return { siblings, path, ancestor };
}

export function getContext(lines: string[], line: number, col: number): Context {
  const text = lines[line] ?? '';
  const before = text.slice(0, col);

  // Reference being typed:  .{na   shared.{   shared.cfg.{x
  const ref = /((?:[\w-]*\.){0,2})\{([^{}\s]*)$/.exec(before);
  if (ref && ref[1].endsWith('.')) {
    // ignore if inside a comment
    if (!/(^|\s)#/.test(before.slice(0, before.length - ref[0].length))) {
      return { kind: 'reference', prefix: ref[1], typed: ref[2] };
    }
  }
  if (/(^|\s)#/.test(before)) return { kind: 'none' };

  const valueM = /^(\s*(?:-\s+)*)([A-Za-z_][\w.-]*)\s*:\s+([^#]*)$/.exec(before);
  if (valueM) {
    const { siblings, path } = mappingInfo(lines, line, valueM[1].length);
    return { kind: 'value', key: valueM[2], path, siblings, typed: valueM[3] };
  }

  const keyM = /^(\s*(?:-\s+)*)([A-Za-z_][\w.-]*)?$/.exec(before);
  if (keyM) {
    const { siblings, path, ancestor } = mappingInfo(lines, line, keyM[1].length);
    let parent: Map<string, string> | undefined;
    if (path[path.length - 1] === 'args' && ancestor) parent = mappingInfo(lines, ancestor.line, ancestor.col).siblings;
    return { kind: 'key', path, siblings, typed: keyM[2] ?? '', parent };
  }
  return { kind: 'none' };
}

/** Top-level keys (and the values of simple scalars) of a file, from raw text. */
export function topLevelKeys(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w.-]*)\s*:/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Names defined at the top of a python file: def / class / assignments. */
export function pythonSymbols(text: string): string[] {
  const out = new Set<string>();
  for (const l of text.split(/\r?\n/)) {
    const m = /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(l) ?? /^([A-Za-z_]\w*)\s*(?::[^=]+)?=/.exec(l);
    if (m && !m[1].startsWith('_')) out.add(m[1]);
  }
  return [...out];
}
