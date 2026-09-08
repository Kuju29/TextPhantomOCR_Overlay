"""Public constants and typed failure for the Lens graph core boundary."""

from __future__ import annotations

from typing import Any

GROUPING_CORE_SCHEMA = "tp.grouping-core/1"
GROUPING_RESULT_SCHEMA = "tp.grouping-result/2"
GROUP_SOURCE_SCHEMA = "tp.group-source/2"


class GroupingResultError(RuntimeError):
    """The core result cannot be mapped without losing identity or content."""

    def __init__(self, code: str, details: dict[str, Any] | None = None):
        self.code = str(code)
        self.details = dict(details or {})
        super().__init__(self.code)
