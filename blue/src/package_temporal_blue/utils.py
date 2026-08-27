"""Launcher contract and small shared helpers, the port of
io.github.getcolors.temporal.utils."""

from __future__ import annotations

# Bump on any change a launcher pinned to an older commit could not survive.
CONTRACT = 1


def disabled_provider(v) -> bool:
    return (v is None or v is False
            or str(v).lower() in ("no", "false", "null"))


def provider(v) -> str | None:
    return None if disabled_provider(v) else str(v).lower()


def host_alias(opts: dict) -> str:
    return str(opts.get("profile") or "") or "temporal"
