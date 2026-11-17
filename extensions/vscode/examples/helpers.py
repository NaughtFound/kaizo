def add(a, b):
    """Add two numbers."""
    return a + b


class Runner:
    def __init__(self, steps: int = 1, verbose: bool = False):
        self.steps = steps

    @classmethod
    def run(cls, steps: int, label: str = "x"):
        return steps

    @staticmethod
    def stop():
        return None
