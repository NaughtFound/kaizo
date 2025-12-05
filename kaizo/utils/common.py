def split_by_first_dot(entry: str) -> tuple[str | None, str]:
    if "." not in entry:
        return None, entry

    parts = entry.split(".", 1)
    return parts[0], parts[1]
