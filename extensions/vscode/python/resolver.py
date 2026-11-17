"""Kaizo VS Code helper: resolve Python modules/symbols WITHOUT importing third-party code.

Reads one JSON request on stdin, writes one JSON response on stdout.

Request:  {"extra": [paths], "allowImport": bool,
           "modules": [names], "symbols": [{"module": m, "name": n}], "lists": [prefixes]}
A module name of the form "@file:/abs/path.py" refers to a file directly (kaizo `local:`).

Source (.py) modules are analysed with `ast` only. Builtin / stdlib C modules are imported
(safe). Third-party compiled modules are imported only when `allowImport` is true.

The script must keep working on the interpreter the user picked, so it only relies on the
standard library and never on newer syntax at runtime (annotations are not evaluated).
"""

from __future__ import annotations

import ast
import contextlib
import importlib
import importlib.machinery
import inspect
import io
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    Json = dict[str, Any]
    Found = tuple[str, str | None, list[str]]
    Hit = tuple["ModData", str, Any]

EXTS = tuple(importlib.machinery.EXTENSION_SUFFIXES)
STDLIB = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names)
MAX_DEPTH = 5
MAX_IMPORT_KIND_RESOLVE = 150
DOC_LIMIT = 1500
FILE_PREFIX = "@file:"
PACKAGE_KINDS = ("package", "namespace")
KNOWN_EMPTY_BASES = {"object", "ABC", "Generic", "Protocol"}
FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)

# ----------------------------------------------------------------------------------------
# locating modules on disk
# ----------------------------------------------------------------------------------------


def _search(dirs: list[Path], seg: str) -> Found | None:
    namespace: list[str] = []
    for d in dirs:
        p = d / seg
        if p.is_dir():
            init = p / "__init__.py"
            if init.is_file():
                return ("package", str(init), [str(p)])
            namespace.append(str(p))
        for suffix in (".py", *EXTS):
            f = d / (seg + suffix)
            if f.is_file():
                return ("module" if suffix == ".py" else "compiled", str(f), [])
    return ("namespace", None, namespace) if namespace else None


def _search_dirs(extra: list[str]) -> list[Path]:
    return [Path(d) for d in [*extra, *sys.path] if d and Path(d).is_dir()]


def find_module(name: str, extra: list[str]) -> Found | None:
    """Return (kind, file, child_dirs) or None. Never imports anything."""
    if name.startswith(FILE_PREFIX):
        path = name[len(FILE_PREFIX) :]
        return ("module", path, []) if Path(path).is_file() else None
    segs = name.split(".")
    if not all(s.isidentifier() for s in segs):
        return None
    if segs[0] in sys.builtin_module_names:
        return ("builtin", None, []) if len(segs) == 1 else None
    dirs = _search_dirs(extra)
    found: Found | None = None
    for i, seg in enumerate(segs):
        found = _search(dirs, seg)
        if found is None or (i < len(segs) - 1 and found[0] not in PACKAGE_KINDS):
            return None
        dirs = [Path(d) for d in found[2]]
    return found


# ----------------------------------------------------------------------------------------
# ast helpers
# ----------------------------------------------------------------------------------------


def _unparse(n: ast.AST | None) -> str | None:
    if n is None:
        return None
    try:
        return ast.unparse(n)
    except (ValueError, TypeError, RecursionError):
        return None


def _param(
    arg: ast.arg,
    kind: str,
    *,
    required: bool,
    default: ast.AST | None,
    file: str | None,
) -> Json:
    return {
        "name": arg.arg,
        "kind": kind,
        "required": required,
        "default": _unparse(default),
        "annotation": _unparse(arg.annotation),
        "line": arg.lineno - 1,
        "col": arg.col_offset,
        "file": file,
    }


def params_of(
    fn: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    skip_first: bool = False,
    file: str | None = None,
) -> list[Json]:
    a = fn.args
    out: list[Json] = []
    positional = [*a.posonlyargs, *a.args]
    first_default = len(positional) - len(a.defaults)
    for i, arg in enumerate(positional):
        default = a.defaults[i - first_default] if i >= first_default else None
        kind = "posonly" if i < len(a.posonlyargs) else "pos"
        out.append(
            _param(arg, kind, required=i < first_default, default=default, file=file)
        )
    if a.vararg:
        out.append(_param(a.vararg, "varargs", required=False, default=None, file=file))
    for arg, default in zip(a.kwonlyargs, a.kw_defaults, strict=True):
        out.append(
            _param(arg, "kwonly", required=default is None, default=default, file=file)
        )
    if a.kwarg:
        out.append(_param(a.kwarg, "varkw", required=False, default=None, file=file))
    if skip_first and out and out[0]["kind"] in ("pos", "posonly"):
        out.pop(0)
    return out


def _sig_part(p: Json, *, seen_kwonly: bool) -> list[str]:
    """Pieces of the signature for one parameter (may include the bare `*`)."""
    if p["kind"] == "varargs":
        return ["*" + p["name"]]
    if p["kind"] == "varkw":
        return ["**" + p["name"]]
    text = p["name"]
    if p.get("annotation"):
        text += ": " + p["annotation"]
    if p.get("default") is not None:
        text += (" = " if p.get("annotation") else "=") + p["default"]
    return ["*", text] if p["kind"] == "kwonly" and not seen_kwonly else [text]


def sig_string(params: list[Json] | None) -> str | None:
    if params is None:
        return None
    parts: list[str] = []
    seen_kwonly = False
    for p in params:
        parts += _sig_part(p, seen_kwonly=seen_kwonly)
        seen_kwonly = seen_kwonly or p["kind"] in ("varargs", "kwonly")
    return "(" + ", ".join(parts) + ")"


def _doc(
    node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef | ast.Module,
) -> str | None:
    try:
        d = ast.get_docstring(node)
    except TypeError:
        d = None
    return d[:DOC_LIMIT] if d else None


def _decorator_names(node: ast.AST) -> list[str]:
    out: list[str] = []
    for d in getattr(node, "decorator_list", []):
        t = d.func if isinstance(d, ast.Call) else d
        if isinstance(t, ast.Name):
            out.append(t.id)
        elif isinstance(t, ast.Attribute):
            out.append(t.attr)
    return out


def _names(t: ast.AST) -> Iterator[ast.Name]:
    if isinstance(t, ast.Name):
        yield t
    elif isinstance(t, (ast.Tuple, ast.List)):
        for e in t.elts:
            yield from _names(e)


def _literal_list(v: ast.AST) -> list[str] | None:
    if not isinstance(v, (ast.List, ast.Tuple)):
        return None
    out: list[str] = []
    for e in v.elts:
        if not (isinstance(e, ast.Constant) and isinstance(e.value, str)):
            return None
        out.append(e.value)
    return out


# ----------------------------------------------------------------------------------------
# module data (parsed once per process)
# ----------------------------------------------------------------------------------------


class ModData:
    """What the AST of one module defines and imports."""

    def __init__(self, name: str, kind: str, file: str | None, *, is_pkg: bool) -> None:
        self.name = name
        self.kind = kind
        self.file = file
        self.is_pkg = is_pkg
        self.tree: ast.Module | None = None
        # name -> FunctionDef / ClassDef node, or ("var", line, col)
        self.defs: dict[str, Any] = {}
        # name -> ("from", module, orig, line, col) | ("mod", module, line, col)
        self.imports: dict[str, tuple[Any, ...]] = {}
        self.stars: list[str] = []
        self.all: list[str] | None = None
        self.reliable = True
        self._parse()

    def _pkg(self) -> str:
        if self.name.startswith(FILE_PREFIX):
            return ""
        return self.name if self.is_pkg else self.name.rpartition(".")[0]

    def _abs(self, level: int, module: str | None) -> str | None:
        if level == 0:
            return module or ""
        pkg = self._pkg()
        base = pkg.split(".") if pkg else []
        if level - 1 > len(base):
            return None
        base = base[: len(base) - (level - 1)]
        if module:
            base = [*base, *module.split(".")]
        return ".".join(base)

    def _parse(self) -> None:
        if not self.file or not self.file.endswith(".py"):
            return
        try:
            self.tree = ast.parse(Path(self.file).read_bytes(), filename=self.file)
        except (OSError, SyntaxError, ValueError):
            self.reliable = False
            return
        self._visit(self.tree.body)

    def _visit(self, body: list[ast.stmt]) -> None:
        for n in body:
            if isinstance(n, (*FUNCTION_NODES, ast.ClassDef)):
                self.defs.setdefault(n.name, n)
            elif isinstance(n, ast.Assign):
                self._visit_assign(n)
            elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
                self.defs.setdefault(
                    n.target.id, ("var", n.target.lineno - 1, n.target.col_offset)
                )
            elif isinstance(n, ast.Import):
                self._visit_import(n)
            elif isinstance(n, ast.ImportFrom):
                self._visit_import_from(n)
            elif isinstance(n, (ast.If, ast.Try, ast.With)):
                self._visit_blocks(n)

    def _visit_assign(self, n: ast.Assign) -> None:
        for t in n.targets:
            for nm in _names(t):
                self.defs.setdefault(nm.id, ("var", nm.lineno - 1, nm.col_offset))
                if nm.id == "__all__":
                    self.all = _literal_list(n.value)

    def _visit_import(self, n: ast.Import) -> None:
        for a in n.names:
            top = a.name.split(".")[0]
            self.imports.setdefault(
                a.asname or top,
                ("mod", a.name if a.asname else top, n.lineno - 1, n.col_offset),
            )

    def _visit_import_from(self, n: ast.ImportFrom) -> None:
        base = self._abs(n.level, n.module)
        if base is None:
            return
        for a in n.names:
            if a.name == "*":
                self.stars.append(base)
            else:
                entry = ("from", base, a.name, n.lineno - 1, n.col_offset)
                self.imports.setdefault(a.asname or a.name, entry)

    def _visit_blocks(self, n: ast.If | ast.Try | ast.With) -> None:
        self._visit(n.body)
        self._visit(getattr(n, "orelse", []))
        for h in getattr(n, "handlers", []):
            self._visit(h.body)
        self._visit(getattr(n, "finalbody", []))


_MODS: dict[str, ModData | None] = {}


def _alias_mod(name: str, extra: list[str]) -> ModData | None:
    """Attribute alias such as os.path (`import posixpath as path` inside os.py)."""
    if "." not in name or name.startswith(FILE_PREFIX):
        return None
    parent, _, seg = name.rpartition(".")
    pm = get_mod(parent, extra)
    imp = pm.imports.get(seg) if pm is not None else None
    if imp is not None and imp[0] == "mod" and imp[1] != name:
        return get_mod(imp[1], extra)
    return None


def get_mod(name: str, extra: list[str]) -> ModData | None:
    if name in _MODS:
        return _MODS[name]
    found = find_module(name, extra)
    if found is None:
        result = _alias_mod(name, extra)
    else:
        kind, file, _dirs = found
        result = ModData(name, kind, file, is_pkg=kind in PACKAGE_KINDS)
    _MODS[name] = result
    return result


# ----------------------------------------------------------------------------------------
# resolving a name inside a module (follows imports / star-imports)
# ----------------------------------------------------------------------------------------


def _def_result(md: ModData, d: Any) -> Hit:
    if isinstance(d, tuple):
        return (md, "var", d)
    return (md, "class" if isinstance(d, ast.ClassDef) else "function", d)


def _import_result(
    md: ModData,
    imp: tuple[Any, ...],
    extra: list[str],
    depth: int,
    seen: set[tuple[str, str]],
) -> Hit | None:
    if imp[0] == "mod":
        return (md, "module", imp)
    hit = lookup(get_mod(imp[1], extra), imp[2], extra, depth + 1, seen)
    if hit is not None:
        return hit
    # `from pkg import submodule`
    dotted = imp[1] + "." + imp[2]
    if get_mod(dotted, extra) is not None:
        return (md, "module", ("mod", dotted, imp[3], imp[4]))
    return None


def lookup(
    md: ModData | None,
    name: str,
    extra: list[str],
    depth: int = 0,
    seen: set[tuple[str, str]] | None = None,
) -> Hit | None:
    """Find `name` in a module: (ModData, kind, payload)."""
    if md is None or depth > MAX_DEPTH:
        return None
    seen = set() if seen is None else seen
    key = (md.name, name)
    if key in seen:
        return None
    seen.add(key)
    if name in md.defs:
        return _def_result(md, md.defs[name])
    if name in md.imports:
        return _import_result(md, md.imports[name], extra, depth, seen)
    for s in md.stars:
        hit = lookup(get_mod(s, extra), name, extra, depth + 1, seen)
        if hit is not None:
            return hit
    return None


# ----------------------------------------------------------------------------------------
# class analysis (inheritance is followed like Python's MRO)
# ----------------------------------------------------------------------------------------


def _base_name(b: ast.AST) -> str | None:
    if isinstance(b, ast.Name):
        return b.id
    if isinstance(b, ast.Attribute):
        return b.attr
    if isinstance(b, ast.Subscript):
        return _base_name(b.value)
    return _unparse(b)


def _resolve_base(md: ModData, b: ast.AST, extra: list[str]) -> Hit | None:
    """Resolve a base-class expression to (ModData, 'class', ClassDef) or None."""
    hit: Hit | None = None
    if isinstance(b, ast.Name):
        hit = lookup(md, b.id, extra)
    elif isinstance(b, ast.Attribute) and isinstance(b.value, ast.Name):
        m = md.imports.get(b.value.id)
        if m and m[0] == "mod":
            hit = lookup(get_mod(m[1], extra), b.attr, extra)
    return hit if hit and hit[1] == "class" else None


def _const(node: ast.AST) -> object:
    return node.value if isinstance(node, ast.Constant) else None


def _call_name(node: ast.AST) -> str | None:
    t = node.func if isinstance(node, ast.Call) else node
    if isinstance(t, ast.Name):
        return t.id
    return t.attr if isinstance(t, ast.Attribute) else None


def _dc_options(cls: ast.ClassDef) -> dict[str, bool]:
    opts = {"is_dc": False, "kw_only": False, "init": True}
    for d in cls.decorator_list:
        if _call_name(d) != "dataclass":
            continue
        opts["is_dc"] = True
        for kw in d.keywords if isinstance(d, ast.Call) else []:
            if kw.arg == "kw_only" and isinstance(kw.value, ast.Constant):
                opts["kw_only"] = bool(kw.value.value)
            if kw.arg == "init" and _const(kw.value) is False:
                opts["init"] = False
    return opts


def _inherited_fields(
    md: ModData,
    cls: ast.ClassDef,
    extra: list[str],
    depth: int,
) -> tuple[dict[str, Json], bool]:
    """Fields of all base classes, applied in reverse MRO order (earlier bases win)."""
    fields: dict[str, Json] = {}
    complete = True
    for b in reversed(cls.bases):
        if _base_name(b) in KNOWN_EMPTY_BASES:
            continue
        hit = _resolve_base(md, b, extra)
        if hit is None:
            complete = False
            continue
        sub, sub_complete = dataclass_fields(hit[0], hit[2], extra, depth + 1)
        fields.update(sub)
        complete = complete and sub_complete
    return fields, complete


def _apply_field_call(
    call: ast.Call, *, required: bool, default: str | None, kw_only: bool
) -> Json:
    """Interpret `field(default=..., default_factory=..., init=..., kw_only=...)`."""
    kws = {k.arg: k.value for k in call.keywords if k.arg}
    res: Json = {
        "required": required,
        "default": default,
        "kw_only": kw_only,
        "skip": False,
    }
    if "init" in kws and _const(kws["init"]) is False:
        res["skip"] = True
    if "kw_only" in kws and _const(kws["kw_only"]) is not None:
        res["kw_only"] = bool(_const(kws["kw_only"]))
    if "default" in kws:
        res.update(required=False, default=_unparse(kws["default"]))
    elif "default_factory" in kws:
        factory = _unparse(kws["default_factory"]) or "..."
        res.update(required=False, default=f"<factory: {factory}>")
    else:
        res.update(required=True, default=None)
    return res


def _own_field(
    md: ModData,
    n: ast.AnnAssign,
    name: str,
    ann: str,
    *,
    kw_only: bool,
) -> Json | None:
    """Parameter for one annotated dataclass attribute (None when init=False)."""
    required = n.value is None
    default = None if n.value is None else _unparse(n.value)
    if isinstance(n.value, ast.Call) and _call_name(n.value) == "field":
        res = _apply_field_call(
            n.value, required=required, default=default, kw_only=kw_only
        )
        if res["skip"]:
            return None
        required, default, kw_only = res["required"], res["default"], res["kw_only"]
    return {
        "name": name,
        "kind": "kwonly" if kw_only else "pos",
        "required": required,
        "default": default,
        "annotation": ann or None,
        "line": n.lineno - 1,
        "col": n.col_offset,
        "file": md.file,
    }


def dataclass_fields(
    md: ModData,
    cls: ast.ClassDef,
    extra: list[str],
    depth: int = 0,
) -> tuple[dict[str, Json], bool]:
    """Ordered {name: param} of the generated __init__, following all bases.

    Mirrors dataclasses: fields are collected from base classes in reverse MRO order, so an
    earlier base overrides a later one and a subclass overrides all of them, while a
    re-declared field keeps its original position. Returns (fields, complete).
    """
    if depth > MAX_DEPTH:
        return {}, False
    fields, complete = _inherited_fields(md, cls, extra, depth)
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
        elif not (ann.startswith("ClassVar") or "ClassVar[" in ann):
            param = _own_field(
                md, n, n.target.id, ann, kw_only=opts["kw_only"] or kw_sentinel
            )
            if param is None:
                fields.pop(n.target.id, None)
            else:
                fields[n.target.id] = param
    return fields, complete


def _method_info(n: ast.FunctionDef | ast.AsyncFunctionDef, md: ModData) -> Json:
    decorators = _decorator_names(n)
    if "property" in decorators or "cached_property" in decorators:
        kind = "property"
    elif "staticmethod" in decorators:
        kind = "static"
    elif "classmethod" in decorators:
        kind = "class"
    else:
        kind = "method"
    params = []
    if kind != "property":
        params = params_of(n, skip_first=kind in ("method", "class"), file=md.file)
    return {
        "kind": kind,
        "params": params,
        "line": n.lineno - 1,
        "col": n.col_offset,
        "file": md.file,
        "doc": _doc(n),
    }


def _attr_info(node: ast.Name | ast.AnnAssign, md: ModData) -> Json:
    return {
        "kind": "attr",
        "params": None,
        "line": node.lineno - 1,
        "col": node.col_offset,
        "file": md.file,
        "doc": None,
    }


def _merge_bases(
    info: Json,
    md: ModData,
    cls: ast.ClassDef,
    extra: list[str],
    depth: int,
) -> None:
    # Python's MRO lets earlier bases win, so apply them last (own definitions come after)
    for b in reversed(cls.bases):
        name = _base_name(b)
        if name in KNOWN_EMPTY_BASES:
            continue
        hit = _resolve_base(md, b, extra)
        if hit is None:
            info["unresolved"].append(name)
            continue
        sub = analyse_class(hit[0], hit[2], extra, depth + 1)
        info["methods"].update(sub["methods"])
        if sub["has_init"]:
            info["init"], info["has_init"] = sub["init"], True
        info["unresolved"] += sub["unresolved"]


def _collect_body(info: Json, md: ModData, cls: ast.ClassDef) -> bool:
    """Record own methods/attributes; returns True when the class defines __init__."""
    own_init = False
    for n in cls.body:
        if isinstance(n, FUNCTION_NODES):
            if n.name == "__init__":
                info["init"] = params_of(n, skip_first=True, file=md.file)
                info["has_init"] = own_init = True
            info["methods"][n.name] = _method_info(n, md)
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    info["methods"].setdefault(t.id, _attr_info(t, md))
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            info["methods"].setdefault(n.target.id, _attr_info(n, md))
    return own_init


def analyse_class(
    md: ModData, cls: ast.ClassDef, extra: list[str], depth: int = 0
) -> Json:
    """Return dict(init=params|None, methods={}, unresolved=[...], bases=[...])."""
    info: Json = {
        "init": None,
        "has_init": False,
        "methods": {},
        "unresolved": [],
        "bases": [],
    }
    if depth > MAX_DEPTH:
        info["unresolved"].append("<too deep>")
        return info
    info["bases"] = [_base_name(b) for b in cls.bases]
    _merge_bases(info, md, cls, extra, depth)
    own_init = _collect_body(info, md, cls)

    opts = _dc_options(cls)
    if opts["is_dc"] and opts["init"] and not own_init:
        fields, complete = dataclass_fields(md, cls, extra, depth)
        ordered = [f for f in fields.values() if f["kind"] != "kwonly"]
        ordered += [f for f in fields.values() if f["kind"] == "kwonly"]
        info["init"] = ordered if complete else None
        info["has_init"] = True
    if not info["has_init"] and not info["unresolved"]:
        info["init"] = []  # object.__init__ takes nothing
    return info


# ----------------------------------------------------------------------------------------
# inspect-based fallback for builtin / compiled modules
# ----------------------------------------------------------------------------------------

_PARAM_KINDS = {
    inspect.Parameter.POSITIONAL_ONLY: "posonly",
    inspect.Parameter.POSITIONAL_OR_KEYWORD: "pos",
    inspect.Parameter.VAR_POSITIONAL: "varargs",
    inspect.Parameter.KEYWORD_ONLY: "kwonly",
    inspect.Parameter.VAR_KEYWORD: "varkw",
}


def _import_ok(name: str, md: ModData | None) -> bool:
    if md is None:
        return False
    return md.kind == "builtin" or name.split(".", 1)[0] in STDLIB


def _dyn_params(obj: Callable[..., object]) -> list[Json] | None:
    try:
        sig = inspect.signature(obj)
    except (TypeError, ValueError):
        return None
    out: list[Json] = []
    for p in sig.parameters.values():
        kind = _PARAM_KINDS[p.kind]
        annotation = None
        if p.annotation is not p.empty:
            annotation = getattr(p.annotation, "__name__", str(p.annotation))
        out.append(
            {
                "name": p.name,
                "kind": kind,
                "required": p.default is p.empty
                and kind in ("pos", "posonly", "kwonly"),
                "default": None if p.default is p.empty else repr(p.default),
                "annotation": annotation,
            },
        )
    return out


def _dyn_module(name: str) -> object | None:
    try:
        with (
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            return importlib.import_module(name)
    except BaseException:  # noqa: BLE001 - importing user code may even call sys.exit()
        return None


def _dyn_kind(o: object) -> str:
    if inspect.isclass(o):
        return "class"
    if inspect.ismodule(o):
        return "module"
    return "function" if callable(o) else "var"


def _dyn_method_kind(raw: object) -> str:
    if isinstance(raw, staticmethod):
        return "static"
    if isinstance(raw, classmethod):
        return "class"
    if isinstance(raw, property):
        return "property"
    return "method" if callable(raw) else "attr"


def _dyn_methods(obj: object) -> dict[str, Json]:
    methods: dict[str, Json] = {}
    for m in dir(obj):
        if m.startswith("_"):
            continue
        try:
            raw = inspect.getattr_static(obj, m)
        except AttributeError:
            continue
        kind = _dyn_method_kind(raw)
        params = None
        if kind in ("method", "static", "class"):
            member = getattr(obj, m, None)
            params = _dyn_params(member) if callable(member) else None
            if params and kind == "method" and params[0]["name"] in ("self", "cls"):
                params = params[1:]
        methods[m] = {
            "kind": kind,
            "params": params,
            "line": 0,
            "col": 0,
            "file": None,
            "doc": None,
        }
    return methods


# ----------------------------------------------------------------------------------------
# public ops
# ----------------------------------------------------------------------------------------


def _def_kind(d: Any) -> str:
    if isinstance(d, ast.ClassDef):
        return "class"
    return "function" if isinstance(d, FUNCTION_NODES) else "var"


def _merge_star(
    members: dict[str, str],
    star: str,
    extra: list[str],
    *,
    allow_import: bool,
) -> bool:
    """Add the names of `from star import *`; False when that module is unreliable."""
    sinfo = module_info(star, extra, allow_import=allow_import)
    if sinfo is None:
        return False
    names = sinfo["all"]
    if names is None:
        names = [k for k in sinfo["members"] if not k.startswith("_")]
    for k in names:
        members.setdefault(k, sinfo["members"].get(k, "import"))
    return bool(sinfo["reliable"])


def _source_members(
    md: ModData,
    extra: list[str],
    *,
    allow_import: bool,
) -> tuple[dict[str, str], bool]:
    members = {n: _def_kind(d) for n, d in md.defs.items()}
    resolved = 0
    for n in md.imports:
        if n in members:
            continue
        hit = lookup(md, n, extra) if resolved < MAX_IMPORT_KIND_RESOLVE else None
        members[n] = hit[1] if hit else "import"
        resolved += 1
    # names can be added dynamically through a module-level __getattr__
    reliable = md.reliable and "__getattr__" not in md.defs
    for s in md.stars:
        reliable = (
            _merge_star(members, s, extra, allow_import=allow_import) and reliable
        )
    return members, reliable


def module_info(name: str, extra: list[str], *, allow_import: bool) -> Json | None:
    md = get_mod(name, extra)
    if md is None:
        return None
    info: Json = {
        "found": True,
        "kind": md.kind,
        "file": md.file,
        "isPackage": md.is_pkg,
        "reliable": True,
        "members": {},
        "all": md.all,
    }
    if md.tree is not None:
        info["members"], info["reliable"] = _source_members(
            md, extra, allow_import=allow_import
        )
        return info
    # no readable python source
    if _import_ok(name, md) or allow_import:
        mod = _dyn_module(name)
        if mod is not None:
            info["members"] = {
                k: _dyn_kind(getattr(mod, k, None))
                for k in dir(mod)
                if not k.startswith("__")
            }
            return info
    info["reliable"] = False
    return info


def _blank_symbol(name: str, kind: str, module: str, file: str | None) -> Json:
    return {
        "found": True,
        "name": name,
        "kind": kind,
        "module": module,
        "file": file,
        "line": 0,
        "col": 0,
        "doc": None,
        "params": None,
        "sig": None,
        "methods": {},
        "unresolved": [],
        "bases": [],
    }


def _source_symbol(md: ModData, name: str, extra: list[str]) -> Json | None:
    hit = lookup(md, name, extra)
    if hit is None:
        return None
    home, kind, payload = hit
    out = _blank_symbol(name, kind, home.name, home.file)
    if kind in ("function", "class"):
        out["line"], out["col"], out["doc"] = (
            payload.lineno - 1,
            payload.col_offset,
            _doc(payload),
        )
    if kind == "function":
        out["params"] = params_of(payload, file=home.file)
        out["sig"] = sig_string(out["params"])
        out["async"] = isinstance(payload, ast.AsyncFunctionDef)
    elif kind == "class":
        ci = analyse_class(home, payload, extra)
        out["params"] = ci["init"]
        out["sig"] = sig_string(ci["init"])
        out.update(
            methods=ci["methods"], unresolved=ci["unresolved"], bases=ci["bases"]
        )
    elif kind == "var":
        out["line"], out["col"] = payload[1], payload[2]
    elif kind == "module":
        out["target"] = payload[1]
        out["line"], out["col"] = payload[2], payload[3]
    return out


def _dyn_symbol(module: str, name: str) -> Json | None:
    mod = _dyn_module(module)
    if mod is None or not hasattr(mod, name):
        return None
    obj = getattr(mod, name)
    kind = _dyn_kind(obj)
    out = _blank_symbol(name, kind, module, None)
    doc = inspect.getdoc(obj)
    out["doc"] = doc[:DOC_LIMIT] if doc else None
    if kind in ("function", "class"):
        out["params"] = _dyn_params(obj)
        out["sig"] = sig_string(out["params"])
    if kind == "class":
        out["methods"] = _dyn_methods(obj)
    return out


def symbol_info(
    module: str, name: str, extra: list[str], *, allow_import: bool
) -> Json | None:
    md = get_mod(module, extra)
    if md is None:
        return None
    if md.tree is not None:
        return _source_symbol(md, name, extra)
    if _import_ok(module, md) or allow_import:
        return _dyn_symbol(module, name)
    out = _blank_symbol(name, "unknown", module, None)
    out["unresolved"] = ["<compiled>"]
    return out


def _scan_entry(entry: Path, *, top: bool, out: dict[str, bool]) -> None:
    name = entry.name
    if name.startswith(("_", ".")) or "-" in name:
        return
    if entry.is_dir():
        if "." not in name and (not top or (entry / "__init__.py").is_file()):
            out.setdefault(name, True)
    elif name.endswith(".py"):
        out.setdefault(name[:-3], False)
    else:
        for ext in EXTS:
            if name.endswith(ext):
                out.setdefault(name[: -len(ext)], False)
                break


def _scan(dirs: list[Path], *, top: bool) -> dict[str, bool]:
    out: dict[str, bool] = {}
    for d in dirs:
        try:
            entries = list(d.iterdir())
        except OSError:
            continue
        for entry in entries:
            _scan_entry(entry, top=top, out=out)
    return out


def list_modules(prefix: str, extra: list[str]) -> list[Json]:
    if prefix == "":
        found = {n: False for n in STDLIB if not n.startswith("_")}
        found.update(_scan(_search_dirs(extra), top=True))
        return [{"name": k, "pkg": bool(v)} for k, v in sorted(found.items())]
    r = find_module(prefix, extra)
    if not r or r[0] not in PACKAGE_KINDS:
        return []
    return [
        {"name": k, "pkg": v}
        for k, v in sorted(_scan([Path(d) for d in r[2]], top=False).items())
    ]


def _run_modules(req: Json, extra: list[str], *, allow: bool) -> Json:
    out: Json = {}
    for m in req.get("modules", []):
        try:
            out[m] = module_info(m, extra, allow_import=allow)
        except Exception as e:  # noqa: BLE001 - keep going, report as not-reliable
            out[m] = {
                "found": True,
                "reliable": False,
                "members": {},
                "error": str(e),
                "kind": "unknown",
                "file": None,
                "isPackage": False,
                "all": None,
            }
    return out


def _run_symbols(req: Json, extra: list[str], *, allow: bool) -> Json:
    out: Json = {}
    for s in req.get("symbols", []):
        key = s["module"] + "::" + s["name"]
        try:
            out[key] = symbol_info(s["module"], s["name"], extra, allow_import=allow)
        except Exception:  # noqa: BLE001 - one bad symbol must not break the rest
            out[key] = None
    return out


def _run_lists(req: Json, extra: list[str]) -> Json:
    out: Json = {}
    for p in req.get("lists", []):
        try:
            out[p] = list_modules(p.rstrip("."), extra)
        except Exception:  # noqa: BLE001 - one bad prefix must not break the rest
            out[p] = []
    return out


def main() -> None:
    req = json.loads(sys.stdin.read() or "{}")
    extra = [p for p in req.get("extra", []) if isinstance(p, str)]
    allow = bool(req.get("allowImport"))
    # never treat the helper's own folder as importable
    here = Path(__file__).resolve().parent
    sys.path[:] = [p for p in sys.path if p and Path(p).resolve() != here]
    out = {
        "python": {
            "version": sys.version.split()[0],
            "executable": sys.executable,
            "prefix": sys.prefix,
        },
        "modules": _run_modules(req, extra, allow=allow),
        "symbols": _run_symbols(req, extra, allow=allow),
        "lists": _run_lists(req, extra),
    }
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
