from huggingface_hub import HfApi

from kaizo import Plugin


class HFPlugin(Plugin):
    def __init__(self, token: str) -> None:
        super().__init__()

        self.api = HfApi(token=token)

    def upload_to_hf_hub(self) -> None:
        pass
