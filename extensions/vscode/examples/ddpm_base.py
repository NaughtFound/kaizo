from dataclasses import dataclass, field, KW_ONLY


@dataclass(kw_only=True)
class DDPMParams:
    beta_min: float = field(default=1e-4)
    beta_max: float = field(default=0.02)
    t0: float = field(default=1e-5)
    t1: float = field(default=1)
    input_size: tuple[int, int, int] = field(default=(1, 28, 28))


@dataclass
class Mixed:
    name: str
    scale: float = 1.0
    _: KW_ONLY
    seed: int
    tags: list = field(default_factory=list)
    hidden: int = field(default=0, init=False)
