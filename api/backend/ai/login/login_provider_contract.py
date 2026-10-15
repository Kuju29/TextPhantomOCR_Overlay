from dataclasses import dataclass

class LoginError(ValueError):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code, self.status = code, status
        self.requestDispatched = False

@dataclass(frozen=True)
class LoginProvider:
    id: str
    label: str
    channel: str
    auth_host: str
    auth_path: str
    callback_port: int
    callback_path: str
    supported: bool = True
    unavailable_reason: str = "unsupported"

    @property
    def redirect_uri(self):
        return f"http://localhost:{self.callback_port}{self.callback_path}"
