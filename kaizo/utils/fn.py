from collections.abc import Callable, MutableMapping, Sequence
from functools import partial
from typing import Any


class FnWithKwargs[R]:
    fn: Callable[..., R]
    args: Sequence[Any]
    kwargs: MutableMapping[str, Any]

    def __init__(
        self,
        fn: Callable[..., R],
        args: Sequence[Any] | None = None,
        kwargs: MutableMapping[str, Any] | None = None,
    ) -> None:
        if args is None:
            args = ()

        if kwargs is None:
            kwargs = {}

        self.fn = fn
        self.args = args
        self.kwargs = kwargs

    def __call__(self, *args, **kwargs) -> R:
        resolved_args = tuple(self.args)
        resolved_kwargs = dict(self.kwargs)

        fn = partial(self.fn, *resolved_args, **resolved_kwargs)

        return fn(*args, **kwargs)

    def update(self, **kwargs) -> None:
        self.kwargs.update(kwargs)
