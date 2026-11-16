"""Kaizo VS Code helper: resolve Python modules/symbols WITHOUT importing third-party code.

Reads one JSON request on stdin, writes one JSON response on stdout.

Request:  {"extra": [paths], "allowImport": bool,
           "modules": [names], "symbols": [{"module": m, "name": n}], "lists": [prefixes]}
A module name of the form "@file:/abs/path.py" refers to a file directly (kaizo `local:`).

Source (.py) modules are analysed with `ast` only. Builtin / stdlib C modules are imported
(safe). Third-party compiled modules are imported only when `allowImport` is true.
"""
import ast
import contextlib
import importlib
import importlib.machinery
import inspect
import io
import json
import os
import sys

EXTS = tuple(importlib.machinery.EXTENSION_SUFFIXES)
STDLIB = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names)
MAX_DEPTH = 5
MAX_IMPORT_KIND_RESOLVE = 150
DOC_LIMIT = 1500

# --------------------------------------------------------------------------------------------
# locating modules on disk
# --------------------------------------------------------------------------------------------


def _search(dirs, seg):
    ns = []
    for d in dirs:
        p = os.path.join(d, seg)
        if os.path.isdir(p):
            init = os.path.join(p, "__init__.py")
            if os.path.isfile(init):
                return ("package", init, [p])
            ns.append(p)
        f = p + ".py"
        if os.path.isfile(f):
            return ("module", f, [])
        for ext in EXTS:
            f = p + ext
            if os.path.isfile(f):
                return ("compiled", f, [])
    if ns:
        return ("namespace", None, ns)
    return None


def find_module(name, extra):
    """Return (kind, file, child_dirs) or None. Never imports anything."""
    if name.startswith("@file:"):
        path = name[6:]
        return ("module", path, []) if os.path.isfile(path) else None
    segs = name.split(".")
    if not all(s.isidentifier() for s in segs):
        return None
    dirs = [d for d in list(extra) + list(sys.path) if d and os.path.isdir(d)]
    cur = None
    for i, seg in enumerate(segs):
        if i == 0 and seg in sys.builtin_module_names:
            if len(segs) > 1:
                return None
            return ("builtin", None, [])
        r = _search(dirs, seg)
        if r is None:
            return None
        cur = r
        dirs = r[2]
        if i < len(segs) - 1 and r[0] not in ("package", "namespace"):
            return None
    return cur


# --------------------------------------------------------------------------------------------
# ast helpers
# --------------------------------------------------------------------------------------------


def _unparse(n):
    if n is None:
        return None
    try:
        return ast.unparse(n)
    except Exception:
        return None


def params_of(fn, skip_first=False, file=None):
    a = fn.args
    out = []
    allpos = list(getattr(a, "posonlyargs", [])) + list(a.args)
    nposonly = len(getattr(a, "posonlyargs", []))
    nd = len(a.defaults)
    for i, arg in enumerate(allpos):
        has_def = i >= len(allpos) - nd
        d = _unparse(a.defaults[i - (len(allpos) - nd)]) if has_def else None
        out.append({
            "name": arg.arg,
            "kind": "posonly" if i < nposonly else "pos",
            "required": not has_def,
            "default": d,
            "annotation": _unparse(arg.annotation),
            "line": arg.lineno - 1, "col": arg.col_offset, "file": file,
        })
    if a.vararg:
        out.append({"name": a.vararg.arg, "kind": "varargs", "required": False, "default": None, "annotation": _unparse(a.vararg.annotation)})
    for arg, d in zip(a.kwonlyargs, a.kw_defaults):
        out.append({"name": arg.arg, "kind": "kwonly", "required": d is None, "default": _unparse(d), "annotation": _unparse(arg.annotation), "line": arg.lineno - 1, "col": arg.col_offset, "file": file})
    if a.kwarg:
        out.append({"name": a.kwarg.arg, "kind": "varkw", "required": False, "default": None, "annotation": _unparse(a.kwarg.annotation)})
    if skip_first and out and out[0]["kind"] in ("pos", "posonly"):
        out.pop(0)
    return out


def sig_string(params):
    if params is None:
        return None
    parts = []
    seen_kwonly = False
    for p in params:
        s = p["name"]
        if p["kind"] == "varargs":
            s = "*" + s
            seen_kwonly = True
        elif p["kind"] == "varkw":
            s = "**" + s
        else:
            if p["kind"] == "kwonly" and not seen_kwonly:
                parts.append("*")
                seen_kwonly = True
            if p.get("annotation"):
                s += ": " + p["annotation"]
            if p.get("default") is not None:
                s += (" = " if p.get("annotation") else "=") + p["default"]
        parts.append(s)
    return "(" + ", ".join(parts) + ")"


def _doc(node):
    try:
        d = ast.get_docstring(node)
    except Exception:
        d = None
    return d[:DOC_LIMIT] if d else None


def _decorator_names(node):
    out = []
    for d in getattr(node, "decorator_list", []):
        t = d.func if isinstance(d, ast.Call) else d
        if isinstance(t, ast.Name):
            out.append(t.id)
        elif isinstance(t, ast.Attribute):
            out.append(t.attr)
    return out


# --------------------------------------------------------------------------------------------
# module data (parsed once per process)
# --------------------------------------------------------------------------------------------


class ModData:
    def __init__(self, name, kind, file, is_pkg, extra):
        self.name = name
        self.kind = kind
        self.file = file
        self.is_pkg = is_pkg
        self.extra = extra
        self.tree = None
        self.defs = {}        # name -> ast node (FunctionDef/ClassDef) | ('var', lineno, col)
        self.imports = {}     # name -> ('from', module, orig, line, col) | ('mod', module, line, col)
        self.stars = []       # absolute module names
        self.all = None
        self.reliable = True
        self.dyn = None       # for imported (inspect) modules
        self._parse()

    def _pkg(self):
        if self.name.startswith("@file:"):
            return ""
        return self.name if self.is_pkg else self.name.rpartition(".")[0]

    def _abs(self, level, module):
        if level == 0:
            return module or ""
        base = self._pkg().split(".") if self._pkg() else []
        if level - 1 > len(base):
            return None
        base = base[: len(base) - (level - 1)]
        if module:
            base = base + module.split(".")
        return ".".join(base)

    def _parse(self):
        if not self.file or not self.file.endswith(".py"):
            return
        try:
            with open(self.file, "rb") as f:
                self.tree = ast.parse(f.read(), filename=self.file)
        except (OSError, SyntaxError, ValueError):
            self.reliable = False
            return
        self._visit(self.tree.body)

    def _visit(self, body):
        for n in body:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.defs.setdefault(n.name, n)
            elif isinstance(n, ast.Assign):
                for t in n.targets:
                    for nm in _names(t):
                        self.defs.setdefault(nm.id, ("var", nm.lineno - 1, nm.col_offset))
                        if nm.id == "__all__":
                            self.all = _literal_list(n.value)
            elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
                self.defs.setdefault(n.target.id, ("var", n.target.lineno - 1, n.target.col_offset))
            elif isinstance(n, ast.Import):
                for a in n.names:
                    nm = a.asname or a.name.split(".")[0]
                    self.imports.setdefault(nm, ("mod", a.name if a.asname else a.name.split(".")[0], n.lineno - 1, n.col_offset))
            elif isinstance(n, ast.ImportFrom):
                base = self._abs(n.level, n.module)
                if base is None:
                    continue
                for a in n.names:
                    if a.name == "*":
                        self.stars.append(base)
                    else:
                        self.imports.setdefault(a.asname or a.name, ("from", base, a.name, n.lineno - 1, n.col_offset))
            elif isinstance(n, (ast.If, ast.Try, ast.With)):
                self._visit(n.body)
                self._visit(getattr(n, "orelse", []))
                for h in getattr(n, "handlers", []):
                    self._visit(h.body)
                self._visit(getattr(n, "finalbody", []))


def _names(t):
    if isinstance(t, ast.Name):
        yield t
    elif isinstance(t, (ast.Tuple, ast.List)):
        for e in t.elts:
            yield from _names(e)


def _literal_list(v):
    if isinstance(v, (ast.List, ast.Tuple)):
        out = []
        for e in v.elts:
            if isinstance(e, ast.Constant) and isinstance(e.value, str):
                out.append(e.value)
            else:
                return None
        return out
    return None


_MODS = {}


def get_mod(name, extra):
    key = name
    if key in _MODS:
        return _MODS[key]
    r = find_module(name, extra)
    if r is None and "." in name and not name.startswith("@file:"):
        # attribute alias such as os.path (`import posixpath as path` inside os.py)
        parent, _, seg = name.rpartition(".")
        pm = get_mod(parent, extra)
        imp = pm.imports.get(seg) if pm is not None else None
        if imp is not None and imp[0] == "mod" and imp[1] != name:
            alias = get_mod(imp[1], extra)
            _MODS[key] = alias
            return alias
        if pm is not None and pm.kind == "builtin":
            pass
    if r is None:
        _MODS[key] = None
        return None
    kind, file, _dirs = r
    md = ModData(name, kind, file, kind in ("package", "namespace"), extra)
    _MODS[key] = md
    return md


# --------------------------------------------------------------------------------------------
# resolving a name inside a module (follows imports / star-imports)
# --------------------------------------------------------------------------------------------


def lookup(md, name, extra, depth=0, seen=None):
    """-> (ModData, kind, payload) kind in class|function|var|module|None."""
    if md is None or depth > MAX_DEPTH:
        return None
    seen = seen or set()
    k = (md.name, name)
    if k in seen:
        return None
    seen.add(k)
    d = md.defs.get(name)
    if d is not None:
        if isinstance(d, tuple):
            return (md, "var", d)
        return (md, "class" if isinstance(d, ast.ClassDef) else "function", d)
    imp = md.imports.get(name)
    if imp is not None:
        if imp[0] == "mod":
            return (md, "module", imp)
        target = get_mod(imp[1], extra)
        r = lookup(target, imp[2], extra, depth + 1, seen)
        if r is not None:
            return r
        # `from pkg import submodule`
        sub = get_mod(imp[1] + "." + imp[2], extra)
        if sub is not None:
            return (md, "module", ("mod", imp[1] + "." + imp[2], imp[3], imp[4]))
        return None
    for s in md.stars:
        r = lookup(get_mod(s, extra), name, extra, depth + 1, seen)
        if r is not None:
            return r
    return None


# --------------------------------------------------------------------------------------------
# class analysis
# --------------------------------------------------------------------------------------------

KNOWN_EMPTY_BASES = {"object", "ABC", "Generic", "Protocol"}


def _base_name(b):
    if isinstance(b, ast.Name):
        return b.id
    if isinstance(b, ast.Attribute):
        return b.attr
    if isinstance(b, ast.Subscript):
        return _base_name(b.value)
    return _unparse(b)


def _resolve_base(md, b, extra):
    """Resolve a base-class expression to (ModData, 'class', ClassDef) or None."""
    r = None
    if isinstance(b, ast.Name):
        r = lookup(md, b.id, extra)
    elif isinstance(b, ast.Attribute) and isinstance(b.value, ast.Name):
        m = md.imports.get(b.value.id)
        if m and m[0] == "mod":
            r = lookup(get_mod(m[1], extra), b.attr, extra)
    return r if r and r[1] == "class" else None


def _const(node):
    return node.value if isinstance(node, ast.Constant) else None


def _dc_options(cls):
    opts = {"is_dc": False, "kw_only": False, "init": True}
    for d in cls.decorator_list:
        t = d.func if isinstance(d, ast.Call) else d
        name = t.id if isinstance(t, ast.Name) else t.attr if isinstance(t, ast.Attribute) else None
        if name != "dataclass":
            continue
        opts["is_dc"] = True
        if isinstance(d, ast.Call):
            for kw in d.keywords:
                if kw.arg == "kw_only" and isinstance(kw.value, ast.Constant):
                    opts["kw_only"] = bool(kw.value.value)
                if kw.arg == "init" and isinstance(kw.value, ast.Constant) and kw.value.value is False:
                    opts["init"] = False
    return opts


def dataclass_fields(md, cls, extra, depth=0):
    """Ordered {name: param} of the generated __init__, following the whole inheritance tree.

    Mirrors dataclasses: fields are collected from base classes in reverse MRO order, so an
    earlier base overrides a later one and a subclass overrides all of them while a re-declared
    field keeps its original position. Returns (fields, complete).
    """
    fields = {}
    complete = True
    if depth > MAX_DEPTH:
        return fields, False
    for b in reversed(cls.bases):
        if isinstance(b, ast.keyword) or _base_name(b) in KNOWN_EMPTY_BASES:
            continue
        r = _resolve_base(md, b, extra)
        if r is None:
            complete = False
            continue
        sub, subc = dataclass_fields(r[0], r[2], extra, depth + 1)
        fields.update(sub)
        complete = complete and subc

    opts = _dc_options(cls)
    if not opts["is_dc"]:
        return fields, complete
    kw_sentinel = False
    for n in cls.body:
        if not (isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)):
            continue
        ann = _unparse(n.annotation) or ""
        if ann in ("KW_ONLY", "dataclasses.KW_ONLY"):
            kw_sentinel = True
            continue
        if ann.startswith("ClassVar") or "ClassVar[" in ann:
            continue
        required = n.value is None
        default = None if n.value is None else _unparse(n.value)
        kw_only = opts["kw_only"] or kw_sentinel
        v = n.value
        if isinstance(v, ast.Call):
            fn = v.func
            fname = fn.id if isinstance(fn, ast.Name) else fn.attr if isinstance(fn, ast.Attribute) else None
            if fname == "field":
                kws = {k.arg: k.value for k in v.keywords if k.arg}
                if "init" in kws and _const(kws["init"]) is False:
                    fields.pop(n.target.id, None)
                    continue
                if "kw_only" in kws and _const(kws["kw_only"]) is not None:
                    kw_only = bool(_const(kws["kw_only"]))
                if "default" in kws:
                    required, default = False, _unparse(kws["default"])
                elif "default_factory" in kws:
                    required, default = False, "<factory: %s>" % (_unparse(kws["default_factory"]) or "...")
                else:
                    required, default = True, None
        fields[n.target.id] = {
            "name": n.target.id,
            "kind": "kwonly" if kw_only else "pos",
            "required": required,
            "default": default,
            "annotation": ann or None,
            "line": n.lineno - 1, "col": n.col_offset, "file": md.file,
        }
    return fields, complete


def analyse_class(md, cls, extra, depth=0):
    """Return dict(init=params|None, methods={}, unresolved=[...], bases=[...])."""
    info = {"init": None, "has_init": False, "methods": {}, "unresolved": [], "bases": []}
    if depth > MAX_DEPTH:
        info["unresolved"].append("<too deep>")
        return info
    plain = [b for b in cls.bases if not isinstance(b, ast.keyword)]
    info["bases"] = [_base_name(b) for b in plain]
    # Python's MRO lets earlier bases win, so apply them last (own definitions come after all bases)
    for b in reversed(plain):
        bn = _base_name(b)
        if bn in KNOWN_EMPTY_BASES:
            continue
        r = _resolve_base(md, b, extra)
        if r is not None:
            sub = analyse_class(r[0], r[2], extra, depth + 1)
            info["methods"].update(sub["methods"])
            if sub["has_init"]:
                info["init"] = sub["init"]
                info["has_init"] = True
            info["unresolved"] += sub["unresolved"]
        else:
            info["unresolved"].append(bn)

    opts = _dc_options(cls)
    own_init = False
    for n in cls.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            ds = _decorator_names(n)
            if "property" in ds or "cached_property" in ds:
                kind = "property"
            elif "staticmethod" in ds:
                kind = "static"
            elif "classmethod" in ds:
                kind = "class"
            else:
                kind = "method"
            if n.name == "__init__":
                info["init"] = params_of(n, skip_first=True, file=md.file)
                info["has_init"] = True
                own_init = True
            info["methods"][n.name] = {
                "kind": kind,
                "params": params_of(n, skip_first=kind in ("method", "class"), file=md.file) if kind != "property" else [],
                "line": n.lineno - 1,
                "col": n.col_offset,
                "file": md.file,
                "doc": _doc(n),
            }
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    info["methods"].setdefault(t.id, {"kind": "attr", "params": None, "line": t.lineno - 1, "col": t.col_offset, "file": md.file, "doc": None})
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            info["methods"].setdefault(n.target.id, {"kind": "attr", "params": None, "line": n.lineno - 1, "col": n.col_offset, "file": md.file, "doc": None})

    if opts["is_dc"] and opts["init"] and not own_init:
        fields, complete = dataclass_fields(md, cls, extra, depth)
        ordered = [f for f in fields.values() if f["kind"] != "kwonly"] + [f for f in fields.values() if f["kind"] == "kwonly"]
        info["init"] = ordered if complete else None
        info["has_init"] = True
    if not info["has_init"] and not info["unresolved"]:
        info["init"] = []   # object.__init__ -> takes nothing
    return info


# --------------------------------------------------------------------------------------------
# inspect-based fallback for builtin / compiled modules
# --------------------------------------------------------------------------------------------


@contextlib.contextmanager
def _quiet():
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = io.StringIO()
    sys.stderr = io.StringIO()
    try:
        yield
    finally:
        sys.stdout, sys.stderr = old_out, old_err


def _import_ok(name, md):
    if md is None:
        return False
    if md.kind == "builtin" or name.split(".")[0] in STDLIB:
        return True
    return False


def _dyn_params(obj):
    try:
        sig = inspect.signature(obj)
    except (TypeError, ValueError):
        return None
    out = []
    for p in sig.parameters.values():
        kind = {
            p.POSITIONAL_ONLY: "posonly", p.POSITIONAL_OR_KEYWORD: "pos", p.VAR_POSITIONAL: "varargs",
            p.KEYWORD_ONLY: "kwonly", p.VAR_KEYWORD: "varkw",
        }[p.kind]
        out.append({
            "name": p.name, "kind": kind, "required": p.default is p.empty and kind in ("pos", "posonly", "kwonly"),
            "default": None if p.default is p.empty else repr(p.default),
            "annotation": None if p.annotation is p.empty else getattr(p.annotation, "__name__", str(p.annotation)),
        })
    return out


def _dyn_module(name):
    try:
        with _quiet():
            return importlib.import_module(name)
    except BaseException:
        return None


def _dyn_kind(o):
    if inspect.isclass(o):
        return "class"
    if inspect.ismodule(o):
        return "module"
    if callable(o):
        return "function"
    return "var"


# --------------------------------------------------------------------------------------------
# public ops
# --------------------------------------------------------------------------------------------


def module_info(name, extra, allow_import):
    md = get_mod(name, extra)
    if md is None:
        return None
    info = {"found": True, "kind": md.kind, "file": md.file, "isPackage": md.is_pkg, "reliable": True, "members": {}, "all": md.all}
    if md.tree is not None:
        members = {}
        for n, d in md.defs.items():
            members[n] = "class" if isinstance(d, ast.ClassDef) else "function" if isinstance(d, (ast.FunctionDef, ast.AsyncFunctionDef)) else "var"
        n_imp = 0
        for n in md.imports:
            if n in members:
                continue
            if n_imp < MAX_IMPORT_KIND_RESOLVE:
                r = lookup(md, n, extra)
                members[n] = r[1] if r else "import"
            else:
                members[n] = "import"
            n_imp += 1
        for s in md.stars:
            sm = get_mod(s, extra)
            if sm is None:
                info["reliable"] = False
                continue
            sinfo = module_info(s, extra, allow_import)
            if sinfo and sinfo["found"]:
                names = sinfo["all"] if sinfo.get("all") is not None else [k for k in sinfo["members"] if not k.startswith("_")]
                for k in names:
                    members.setdefault(k, sinfo["members"].get(k, "import"))
                if not sinfo["reliable"]:
                    info["reliable"] = False
        info["members"] = members
        info["reliable"] = info["reliable"] and md.reliable
        # names added dynamically are possible with __getattr__
        if "__getattr__" in md.defs:
            info["reliable"] = False
        return info
    # no readable python source
    if _import_ok(name, md) or allow_import:
        mod = _dyn_module(name)
        if mod is not None:
            info["members"] = {k: _dyn_kind(getattr(mod, k, None)) for k in dir(mod) if not k.startswith("__")}
            return info
    info["reliable"] = False
    return info


def symbol_info(module, name, extra, allow_import):
    md = get_mod(module, extra)
    if md is None:
        return None
    if md.tree is not None:
        r = lookup(md, name, extra)
        if r is None:
            return None
        home, kind, payload = r
        out = {"found": True, "name": name, "kind": kind, "module": home.name, "file": home.file, "line": 0, "col": 0, "doc": None, "params": None, "sig": None, "methods": {}, "unresolved": [], "bases": []}
        if kind in ("function", "class"):
            out["line"] = payload.lineno - 1
            out["col"] = payload.col_offset
            out["doc"] = _doc(payload)
            # point at the name, not at a decorator
            if payload.decorator_list:
                pass
        if kind == "function":
            out["params"] = params_of(payload, file=home.file)
            out["sig"] = sig_string(out["params"])
            out["async"] = isinstance(payload, ast.AsyncFunctionDef)
        elif kind == "class":
            ci = analyse_class(home, payload, extra)
            out["params"] = ci["init"]
            out["sig"] = sig_string(ci["init"])
            out["methods"] = ci["methods"]
            out["unresolved"] = ci["unresolved"]
            out["bases"] = ci["bases"]
        elif kind == "var":
            out["line"], out["col"] = payload[1], payload[2]
        elif kind == "module":
            out["target"] = payload[1]
            out["line"], out["col"] = payload[2], payload[3]
        return out
    if _import_ok(module, md) or allow_import:
        mod = _dyn_module(module)
        if mod is None or not hasattr(mod, name):
            return None
        obj = getattr(mod, name)
        kind = _dyn_kind(obj)
        out = {"found": True, "name": name, "kind": kind, "module": module, "file": None, "line": 0, "col": 0, "params": None, "sig": None, "methods": {}, "unresolved": [], "bases": []}
        d = inspect.getdoc(obj)
        out["doc"] = d[:DOC_LIMIT] if d else None
        if kind in ("function", "class"):
            out["params"] = _dyn_params(obj)
            if out["params"] is not None:
                out["sig"] = sig_string(out["params"])
        if kind == "class":
            for m in dir(obj):
                if m.startswith("_"):
                    continue
                try:
                    raw = inspect.getattr_static(obj, m)
                except AttributeError:
                    continue
                mk = "static" if isinstance(raw, staticmethod) else "class" if isinstance(raw, classmethod) else "property" if isinstance(raw, property) else "method" if callable(raw) else "attr"
                ps = None
                if mk in ("method", "static", "class"):
                    ps = _dyn_params(getattr(obj, m, None))
                    if ps and mk == "method" and ps[0]["name"] in ("self", "cls"):
                        ps = ps[1:]
                out["methods"][m] = {"kind": mk, "params": ps, "line": 0, "col": 0, "file": None, "doc": None}
            out["unresolved"] = []
        return out
    return {"found": True, "name": name, "kind": "unknown", "module": module, "file": None, "line": 0, "col": 0, "params": None, "sig": None, "methods": {}, "unresolved": ["<compiled>"], "bases": [], "doc": None}


def _scan(dirs, top):
    out = {}
    for d in dirs:
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for e in names:
            if e.startswith(("_", ".")) or "-" in e:
                continue
            full = os.path.join(d, e)
            if os.path.isdir(full):
                if "." in e:
                    continue
                if os.path.isfile(os.path.join(full, "__init__.py")) or not top:
                    out.setdefault(e, True)
            elif e.endswith(".py"):
                out.setdefault(e[:-3], False)
            else:
                for ext in EXTS:
                    if e.endswith(ext):
                        out.setdefault(e[: -len(ext)], False)
                        break
    return out


def list_modules(prefix, extra):
    if prefix == "":
        found = {n: n not in sys.builtin_module_names and False for n in STDLIB if not n.startswith("_")}
        dirs = [d for d in list(extra) + list(sys.path) if d and os.path.isdir(d)]
        found.update({k: v for k, v in _scan(dirs, True).items()})
        return [{"name": k, "pkg": bool(v)} for k, v in sorted(found.items())]
    r = find_module(prefix, extra)
    if not r or r[0] not in ("package", "namespace"):
        return []
    return [{"name": k, "pkg": v} for k, v in sorted(_scan(r[2], False).items())]


def main():
    req = json.loads(sys.stdin.read() or "{}")
    extra = [p for p in req.get("extra", []) if isinstance(p, str)]
    allow = bool(req.get("allowImport"))
    # never treat the helper's own folder as importable
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if p and os.path.abspath(p) != here]
    out = {"python": {"version": sys.version.split()[0], "executable": sys.executable, "prefix": sys.prefix}, "modules": {}, "symbols": {}, "lists": {}}
    for m in req.get("modules", []):
        try:
            out["modules"][m] = module_info(m, extra, allow)
        except Exception as e:  # keep going, report as not-reliable
            out["modules"][m] = {"found": True, "reliable": False, "members": {}, "error": str(e), "kind": "unknown", "file": None, "isPackage": False, "all": None}
    for s in req.get("symbols", []):
        key = s["module"] + "::" + s["name"]
        try:
            out["symbols"][key] = symbol_info(s["module"], s["name"], extra, allow)
        except Exception as e:
            out["symbols"][key] = None
    for p in req.get("lists", []):
        try:
            out["lists"][p] = list_modules(p.rstrip("."), extra)
        except Exception:
            out["lists"][p] = []
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
