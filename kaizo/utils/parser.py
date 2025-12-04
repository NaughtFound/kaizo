import importlib
import os
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Any

import yaml

from .entry import DictEntry, Entry, FieldEntry, ListEntry, ModuleEntry


class ConfigParser:
    config: dict[str]
    local: ModuleType | None
    variables: DictEntry[str]
    kwargs: dict[str]

    def __init__(self, config_path: str | Path, kwargs: dict[str] | None = None) -> None:
        root, _ = os.path.split(config_path)

        root = Path(root)

        with Path.open(config_path) as file:
            self.config = yaml.safe_load(file)

        if "local" in self.config:
            local_path = Path(self.config.pop("local"))
            self.local = self._load_python_module(root / local_path)
        else:
            self.local = None

        self.variables = DictEntry(resolve=False)
        self.kwargs = kwargs or {}

    def _load_python_module(self, path: Path) -> ModuleType:
        if not path.is_file():
            msg = f"Local Python file not found: {path}"
            raise FileNotFoundError(msg)

        module_name = path.stem
        spec = spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            msg = f"Failed to load module from: {path}"
            raise ImportError(msg)

        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _load_object(self, module_path: str, object_name: str) -> Any:
        try:
            module = importlib.import_module(module_path)
            if not hasattr(module, object_name):
                msg = f"Module '{module_path}' has no attribute '{object_name}'"
                raise AttributeError(msg)
            return getattr(module, object_name)
        except ModuleNotFoundError as e:
            msg = f"Could not import module '{module_path}': {e}"
            raise ImportError(msg) from e

    def _load_symbol_from_module(self, module_path: str, symbol_name: str) -> Any:
        if module_path == "local":
            if self.local is None:
                msg = "local module is not given"
                raise ValueError(msg)

            return getattr(self.local, symbol_name)

        return self._load_object(module_path, symbol_name)

    def _resolve_string(self, key: str, entry: str) -> Entry:
        if entry.startswith("args."):
            key = entry.split(".")[1]
            return self.variables.get(key)

        return FieldEntry(key=key, value=entry)

    def _resolve_list(self, key: str, entry: list) -> FieldEntry[list]:
        return FieldEntry(key=key, value=ListEntry([self._resolve_entry(e) for e in entry]))

    def _resolve_args(self, key: str, args: Any) -> DictEntry[str]:
        resolved = DictEntry()

        if isinstance(args, dict):
            for k, v in args.items():
                if k in self.kwargs:
                    resolved[k] = self.kwargs[k]
                else:
                    resolved[k] = self._resolve_entry(key, v)

                self.variables[k] = resolved[k]

        return resolved

    def _resolve_dict(self, key: str, entry: dict[str]) -> Entry:
        module_path = entry.get("module")
        symbol_name = entry.get("source")

        if module_path is None or symbol_name is None:
            return FieldEntry(
                key=key,
                value=DictEntry({k: self._resolve_entry(v) for k, v in entry.items()}),
            )

        call = entry.get("call", True)
        lazy = entry.get("lazy", False)
        args = entry.get("args", {})

        obj = self._load_symbol_from_module(module_path, symbol_name)

        resolved_args = self._resolve_args(key, args)

        return ModuleEntry(key=key, obj=obj, call=call, lazy=lazy, args=resolved_args)

    def _resolve_entry(self, key: str, entry: Any) -> Entry:
        if isinstance(entry, str):
            return self._resolve_string(key, entry)

        if isinstance(entry, list):
            return self._resolve_list(key, entry)

        if isinstance(entry, dict):
            return self._resolve_dict(key, entry)

        return FieldEntry(key=key, value=entry)

    def parse(self) -> DictEntry[str]:
        res = DictEntry()

        for k in self.config:
            res[k] = self._resolve_entry(k, self.config[k])

        return res
