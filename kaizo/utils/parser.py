import importlib
import os
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Any

import yaml

from .fn import FnWithKwargs


class ConfigParser:
    config: dict[str]
    local: ModuleType | None
    variables: dict[str]
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

        self.variables = {}
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

    def _resolve_string(self, entry: str) -> Any:
        if entry.startswith("args."):
            key = entry.split(".")[1]
            return self.variables.get(key)

        return entry

    def _resolve_list(self, entry: list) -> list:
        return [self._resolve_entry(e) for e in entry]

    def _resolve_args(self, args: Any) -> dict[str]:
        resolved = {}
        if isinstance(args, dict):
            for k, v in args.items():
                if k in self.kwargs:
                    resolved[k] = self.kwargs[k]
                else:
                    resolved[k] = self._resolve_entry(v)

                self.variables[k] = resolved[k]

        return resolved

    def _resolve_dict(self, entry: dict[str]) -> Any:
        module_path = entry.get("module")
        symbol_name = entry.get("source")

        if module_path is None or symbol_name is None:
            return {k: self._resolve_entry(v) for k, v in entry.items()}

        call = entry.get("call", True)
        lazy = entry.get("lazy", False)
        args = entry.get("args", {})

        obj = self._load_symbol_from_module(module_path, symbol_name)

        resolved_args = self._resolve_args(args)

        return self._call_or_return(obj, call, lazy, resolved_args)

    def _resolve_entry(self, entry: Any) -> Any:
        if isinstance(entry, str):
            return self._resolve_string(entry)

        if isinstance(entry, list):
            return self._resolve_list(entry)

        if isinstance(entry, dict):
            return self._resolve_dict(entry)

        return entry

    def _call_or_return(
        self,
        obj: Any,
        call: Any,
        lazy: bool,
        args: dict[str],
    ) -> Any:
        if call is False:
            return obj

        if call is True:
            if not callable(obj):
                msg = f"'{obj}' is not callable"
                raise TypeError(msg)

            if lazy:
                return FnWithKwargs(fn=obj, kwargs=args)

            return obj(**args)

        if not hasattr(obj, call):
            msg = f"'{obj}' has no attribute '{call}'"
            raise AttributeError(msg)

        fn = getattr(obj, call)

        if not callable(fn):
            msg = f"{fn} is not callable"
            raise TypeError(msg)

        if lazy:
            return FnWithKwargs(fn=fn, kwargs=args)

        return fn(**args)

    def parse(self) -> dict[str]:
        res = {}

        for k in self.config:
            res[k] = self._resolve_entry(self.config[k])

        return res
