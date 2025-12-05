from pathlib import Path

from kaizo import ConfigParser

RESULT = 1

main_py = """
num_call = 0
def fn():
    global num_call

    num_call+=1
    return num_call

def fn2(n):
    return n
"""

config = """
local: main.py
run01:
  module: local
  source: fn2
  call: true
  args:
    n:
        module: local
        source: fn
run02:
    module: local
    source: fn2
    args:
        n: .n
"""


def test_num_call(tmp_path: Path) -> None:
    module = tmp_path / "main.py"
    module.write_text(main_py)

    cfg_file = tmp_path / "cfg.yml"
    cfg_file.write_text(config)

    parser = ConfigParser(cfg_file)
    out = parser.parse()

    assert "run02" in out
    assert out["run02"] == RESULT
