from pathlib import Path


def is_path_like(entry: str) -> bool:
    p = Path(entry)

    if len(p.parts) > 1:
        return True

    return bool(p.drive)


def split_by_first_dot(entry: str) -> tuple[str | None, str]:
    if "." not in entry:
        return None, entry

    if is_path_like(entry):
        return None, entry

    parts = entry.split(".", 1)
    return parts[0], parts[1]
