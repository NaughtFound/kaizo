from pathlib import Path

from kaizo.utils.parser import ConfigParser

VAL = 4

config = f"""
val: {VAL}
use_args:
  module: math
  source: sqrt
  call: true
  args:
    - args.val
"""


def test_args_reference(tmp_path: Path) -> None:
    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(config)

    parser = ConfigParser(cfg_file)
    out = parser.parse()

    assert out["val"] == VAL
    assert out["use_args"] == VAL**0.5
