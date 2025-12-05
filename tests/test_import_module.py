from pathlib import Path

from kaizo import ConfigParser

X = 5

module_config = f"""
x: {X}
"""

config = """
import:
  m: {tmp_path}/module.yml
run: m.x
"""


def test_import_module(tmp_path: Path) -> None:
    module = tmp_path / "module.yml"
    module.write_text(module_config)

    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(config.format(tmp_path=tmp_path))

    parser = ConfigParser(cfg_file)
    out = parser.parse()

    assert out["run"] == X
