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

    def _resolve_entry(self, entry: Any) -> Any:  # noqa: C901, PLR0911, PLR0912
        if isinstance(entry, str) and entry.startswith("args."):
            key = entry.split(".")[1]
            return self.variables.get(key)

        if not isinstance(entry, dict):
            return entry

        module_path = entry["module"]
        symbol_name = entry["source"]
        call = entry.get("call", True)
        lazy = entry.get("lazy", False)
        args = entry.get("args", {})

        obj = None

        if module_path == "local":
            obj = getattr(self.local, symbol_name)
        else:
            obj = self._load_object(module_path, symbol_name)

        if not call:
            return obj

        if isinstance(args, dict):
            for k in args:
                if k in self.kwargs:
                    args[k] = self.kwargs[k]
                else:
                    args[k] = self._resolve_entry(args[k])

                self.variables[k] = args[k]

        if isinstance(call, bool):
            if not callable(obj):
                msg = f"{obj} is not callable"
                raise TypeError(msg)

            if lazy:
                return FnWithKwargs(fn=obj, kwargs=args)

            return obj(**args)

        if not hasattr(obj, call):
            msg = f"Module '{symbol_name}' has no attribute '{call}'"
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
