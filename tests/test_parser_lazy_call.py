from pathlib import Path

from kaizo.utils.fn import FnWithKwargs
from kaizo.utils.parser import ConfigParser

VAL = 9

config = f"""
fn:
  module: math
  source: sqrt
  call: true
  lazy: true
  args:
    - {VAL}
"""


def test_lazy_call(tmp_path: Path) -> None:
    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(config)

    parser = ConfigParser(cfg_file)
    out = parser.parse()

    entry = out["fn"]
    assert isinstance(entry, FnWithKwargs)

    assert entry() == VAL**0.5
