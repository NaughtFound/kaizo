from dataclasses import dataclass
from ddpm_base import DDPMParams, Mixed


@dataclass(kw_only=True)
class DDPMConfig(DDPMParams):
    # Optimization
    lr: float = 3e-4

    # Sampling
    num_samples: int = 16

    # EMA
    use_ema: bool = True
    ema_decay: float = 0.99
    ema_start: int = 15
    ema_update_freq: int = 1
    t0: float = 0.5          # overrides the base default


@dataclass
class Extended(Mixed):
    extra: int = 3


class Plain(DDPMConfig):
    """Not decorated: inherits the generated __init__."""

    def sample(self, n: int = 1):
        return n


class A:
    def who(self, x): ...


class B:
    def who(self, y): ...


class C(A, B):
    pass
