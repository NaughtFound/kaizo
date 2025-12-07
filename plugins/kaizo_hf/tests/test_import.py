import pytest


def test_plugin_importable() -> None:
    try:
        import kaizo.plugins.hf  # noqa: F401, PLC0415
    except Exception as e:
        pytest.fail(f"Importing the plugin raised an exception: {e}")
