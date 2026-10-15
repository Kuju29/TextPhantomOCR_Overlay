""".92 Login ChatGPT AI think: what each of our send paths can control.

Evidence (docs/login-web-fields-10492.md): chatgpt.com's own send is
POST /backend-api/f/conversation with "thinking_effort" (configurable models)
or "system_hints":["reason"] (free Think), and it carries sentinel/turnstile
proofs the website produces. TextPhantom must never forge those, and:
- website path (free plans): the extension types into the chatgpt.com tab and
  the website builds the request -> no field of ours reaches it; the relay job
  carries only account/action/chat/prompt;
- official path (Sign in with ChatGPT): api.openai.com /v1/responses body stays
  {model, input, store, stream}; the /v1/models rows we read carry no reasoning
  fields, so AI think stays the provider default.
Both: no ENDPOINT_THINKING, rows website-managed (app_controlled false), and no
code of ours posts /backend-api/f/conversation. Offline, fictional HTTP only."""
import json
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
sys.path.insert(0, str(ROOT / 'scripts'))
from backend.ai.login import login_provider_chatgpt as chatgpt  # noqa: E402
from backend.ai.login.endpoint import login_endpoint_http as endpoint  # noqa: E402
from backend.ai.thinking_state import classify_thinking_state  # noqa: E402
from login_relay_fixture import relay_via  # noqa: E402

CLIENT = httpx.Client
ACCOUNT = 'a' * 64


def responses_stream(text):
    events = [{'type': 'response.output_text.delta', 'delta': text},
              {'type': 'response.completed', 'response': {'usage': {'input_tokens': 1, 'output_tokens': 1}}}]
    return ''.join('data: ' + json.dumps(e) + '\n\n' for e in events).encode()


class ChatgptThinking(unittest.TestCase):
    def test_no_thinking_switch_and_rows_are_website_managed(self):
        self.assertFalse(getattr(chatgpt, 'ENDPOINT_THINKING', False))
        for row in (chatgpt.website_model(), chatgpt.official_model({'slug': 'gpt-fixture', 'title': 'GPT Fixture'})):
            reasoning = row['model_capabilities']['reasoning']
            self.assertIs(reasoning['app_controlled'], False)
            self.assertEqual(classify_thinking_state(reasoning, fresh=True), 'default')

    def test_official_body_has_only_the_documented_fields(self):
        bodies = []

        def handle(request):
            self.assertEqual((request.method, request.url.host, request.url.path), ('POST', 'api.openai.com', '/v1/responses'))
            bodies.append(json.loads(request.content))
            return httpx.Response(200, content=responses_stream('ok'), headers={'content-type': 'text/event-stream'})
        with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: CLIENT(transport=httpx.MockTransport(handle), **kw)), \
                patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), relay_via(handle):
            result = chatgpt.endpoint_generate({'mode': 'official', 'account': ACCOUNT, 'plan': 'plus'}, 'prompt', {},
                                               'gpt-fixture', lambda: None, lambda: None)
        self.assertEqual(result['text'], 'ok')
        self.assertEqual(set(bodies[0]), {'model', 'input', 'store', 'stream'})

    def test_website_turn_carries_no_model_or_effort_field(self):
        jobs = []

        def relay(provider, job, check, dispatch=None):
            jobs.append((provider, job))
            if dispatch:
                dispatch()
            return {'text': 'ok', 'chat': 'wc_' + 'b' * 32}
        with patch.object(chatgpt, 'relay_webchat', side_effect=relay):
            chatgpt.endpoint_generate({'mode': 'website', 'account': ACCOUNT, 'plan': 'free'}, 'prompt', {},
                                      chatgpt.WEBSITE_MODEL, lambda: None, lambda: None)
        self.assertEqual(set(jobs[0][1]), {'action', 'account', 'chat', 'prompt'})

    def test_no_code_posts_the_website_conversation_api(self):
        # Only the step label for diagnostics names it as a literal; nothing builds that request.
        hits = []
        for folder, pattern in ((ROOT / 'src', '*.js'), (ROOT / 'api' / 'backend', '*.py')):
            for path in folder.rglob(pattern):
                if 'guide' in path.parts or '__pycache__' in path.parts:
                    continue
                text = path.read_text('utf-8', errors='replace')
                if re.search(r'''['"](?:/backend-api/f/conversation|thinking_effort|system_hints)['"]''', text):
                    hits.append(path.relative_to(ROOT).as_posix())
        self.assertEqual(hits, ['api/backend/ai/login/endpoint/login_endpoint_http.py'])


if __name__ == '__main__':
    unittest.main()
