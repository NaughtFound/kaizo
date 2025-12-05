from pathlib import Path

import pytest

from kaizo import ConfigParser

missing_config = """
local: missing.py
"""

not_exist_config = """
bad:
  module: does_not_exist
  source: thing
"""


def test_missing_local_module(tmp_path: Path) -> None:
    cfg = tmp_path / "cfg.yml"
    cfg.write_text(missing_config)

    with pytest.raises(FileNotFoundError):
        ConfigParser(cfg)


def test_import_error(tmp_path: Path) -> None:
    cfg = tmp_path / "cfg.yml"
    cfg.write_text(not_exist_config)

    parser = ConfigParser(cfg)

    with pytest.raises(ImportError):
        parser.parse()
