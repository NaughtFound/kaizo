import importlib
import shutil
import sys
from pathlib import Path

import pytest

missing_config = """
plugins:
  nonexistent:
    source: MyPlugin
"""

missing_source_config = """
plugins:
  missing:
    args:
      z: 10
"""

bad_plugin_config = """
plugins:
  bad: MyPlugin
"""

wrong_plugin_config = """
plugins:
  wrong: MyPlugin
"""
wrong_plugin_py = """
class MyPlugin:
    pass
"""

correct_plugin_config = """
plugins:
  correct: MyPlugin
"""
correct_plugin_py = """
from kaizo.plugins import Plugin

class MyPlugin(Plugin):
    pass
"""

X = 7
Y = 6

plugin_with_args_config = f"""
plugins:
  dummy:
    source: MyPlugin
    args:
      x: {X}
      y: {Y}
"""
plugin_with_args_py = """
from kaizo.plugins import Plugin

class MyPlugin(Plugin):
    def __init__(self, x,y):
        self.x = x
        self.y = y
"""


def create_fake_plugin(tmp_path: Path, name: str, body: str) -> Path:
    real_kaizo = importlib.import_module("kaizo")

    real_kaizo_path = Path(real_kaizo.__file__).parent

    dest_path = tmp_path / "kaizo"

    shutil.copytree(real_kaizo_path, dest_path)

    plugins_dir = dest_path / "plugins"
    plugins_dir.mkdir(parents=True, exist_ok=True)

    plugin_file = plugins_dir / f"{name}.py"
    plugin_file.write_text(body)

    if str(tmp_path) in sys.path:
        sys.path.remove(str(tmp_path))
    sys.path.insert(0, str(tmp_path))

    for mod in list(sys.modules):
        if mod == "kaizo" or mod.startswith("kaizo."):
            del sys.modules[mod]

    importlib.invalidate_caches()

    return plugin_file


def test_plugin_missing_module(tmp_path: Path) -> None:
    kaizo = importlib.import_module("kaizo")

    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(missing_config)

    with pytest.raises(ImportError):
        kaizo.ConfigParser(cfg_file)


def test_plugin_missing_source_key(tmp_path: Path) -> None:
    create_fake_plugin(tmp_path, "missing", body="")
    kaizo = importlib.import_module("kaizo")

    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(missing_source_config)

    with pytest.raises(ValueError, match="source is required for missing plugin"):
        kaizo.ConfigParser(cfg_file)


def test_plugin_missing_source_attr(tmp_path: Path) -> None:
    create_fake_plugin(tmp_path, "bad", body="")
    kaizo = importlib.import_module("kaizo")

    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(bad_plugin_config)

    with pytest.raises(AttributeError):
        kaizo.ConfigParser(cfg_file)


def test_plugin_not_subclass(tmp_path: Path) -> None:
    create_fake_plugin(tmp_path, "wrong", body=wrong_plugin_py)
    kaizo = importlib.import_module("kaizo")

    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(wrong_plugin_config)

    with pytest.raises(TypeError):
        kaizo.ConfigParser(cfg_file)


def test_plugin_subclass(tmp_path: Path) -> None:
    create_fake_plugin(tmp_path, "correct", body=correct_plugin_py)
    kaizo = importlib.import_module("kaizo")

    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(correct_plugin_config)

    parser = kaizo.ConfigParser(cfg_file)
    assert parser.plugins is not None
    assert "correct" in parser.plugins


def test_plugin_with_args(tmp_path: Path) -> None:
    create_fake_plugin(tmp_path, "dummy", body=plugin_with_args_py)
    kaizo = importlib.import_module("kaizo")

    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(plugin_with_args_config)

    parser = kaizo.ConfigParser(cfg_file)
    obj = parser.plugins["dummy"]

    assert isinstance(obj, kaizo.utils.FnWithKwargs)
