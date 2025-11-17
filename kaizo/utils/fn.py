from collections.abc import Callable
from copy import deepcopy
from typing import Generic, TypeVar

R = TypeVar("R")


class FnWithKwargs(Generic[R]):
    fn: Callable
    kwargs: dict[str] | None

    def __init__(
        self,
        fn: Callable[..., R],
        kwargs: dict[str] | None = None,
    ) -> None:
        self.fn = fn

        if kwargs is None:
            kwargs = {}

        self.kwargs = kwargs

    def __call__(self, *args, **kwargs) -> R:
        call_kwargs = deepcopy(self.kwargs)
        call_kwargs.update(kwargs)

        return self.fn(*args, **call_kwargs)

    def update(self, **kwargs) -> None:
        self.kwargs.update(kwargs)
