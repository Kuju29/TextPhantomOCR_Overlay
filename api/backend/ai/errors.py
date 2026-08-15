"""Typed failures raised when a model answer breaks the translation contract."""

from __future__ import annotations

from typing import Any


class ModelOutputContractError(RuntimeError):
    """The provider answered, but its answer cannot be mapped losslessly.

    ``structural_details`` deliberately contains structure only (IDs, field
    names and type failures), never translated text.  API/trace layers can log
    it without exposing a page's dialogue.
    """

    code = "model_output_contract"

    def __init__(
        self,
        message: str,
        *,
        response_shape: str = "unknown",
        **details: Any,
    ) -> None:
        super().__init__(message)
        self.response_shape = response_shape
        self.structural_details = {
            "responseShape": response_shape,
            **{key: value for key, value in details.items() if value not in (None, [], {})},
        }

