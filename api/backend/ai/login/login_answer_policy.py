"""Conservative recognition of unstructured provider policy refusals.

Quoted dialogue in a translation record is ordinary content. A refusal ends
the current run so automatic repair never resubmits a policy-rejected prompt.
"""
import re
from .login_provider_contract import LoginError

_RECORD = re.compile(r'<<(?:TP_P\d+|I[1-9]\d{0,6}_P\d{1,6}):(?:(?!>>).)*>>', re.S)
_POLICY = re.compile(r'\b(?:guidelines|polic(?:y|ies)|safety|prohibited|disallowed)\b', re.I)
_DECLINE = re.compile(r"(?:\b(?:can(?:not|['’]t)|unable to)\s+(?:help|assist|provide|fulfill|comply)|\b(?:go(?:es)?|would go|may go) against\b|\b(?:violat\w*|not allowed)\b)", re.I)

# Whole-answer messages observed from the Gemini consumer site. A completed
# provider candidate can still be a service failure or an unfulfilled request.
# Keep this narrow: error dialogue inside a translation record remains content,
# and these messages do not establish a quota, cooldown or policy rejection.
_GEMINI_ERROR_REPLIES = frozenset(value.casefold() for value in (
    'ฉันเป็น AI ที่ทำงานตามข้อความโต้ตอบ คำถามนี้เกินความสามารถของฉัน',
    'I encountered an error doing what you asked. Could you try again?',
    'Sorry, something went wrong. Please try your request again.',
    "I'm having a hard time fulfilling your request. Can I help you with something else instead?",
    'I seem to be encountering an error. Can I try something else for you?',
))


def reject_provider_error_reply(text, provider, upstream_status=None):
    if provider != 'login_gemini' or not isinstance(text, str):
        return
    if ' '.join(text.split()).casefold() in _GEMINI_ERROR_REPLIES:
        error = LoginError('login_provider_reply_failed',
            'Gemini returned an error or declined the request instead of translations. '
            'This conversation has stopped; start a new translation run.', 502)
        error.provider_reason = 'provider_error_reply'
        error.requestDispatched = True
        if type(upstream_status) is int and 100 <= upstream_status <= 599:
            error.upstream_status = upstream_status
        error.endpoint_step = 'gemini_completion'
        raise error


def reject_policy_refusal(text):
    if not isinstance(text, str):
        return
    # Complete records can contain quoted refusal dialogue. An incomplete or
    # quoted marker outside them must not hide the provider's refusal prose.
    answer = _RECORD.sub('', text).strip()
    # Limit to a short whole-answer refusal, avoiding policy discussions and
    # accidental matches inside long unstructured but legitimate output.
    if len(answer) <= 1600 and _POLICY.search(answer) and _DECLINE.search(answer):
        error = LoginError('login_content_refused',
            'The AI provider declined this content under its policy. Automatic repair has stopped.', 422)
        error.requestDispatched = True
        raise error
