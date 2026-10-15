""".82 ChatGPT website answers: chatgpt.com's formatter shows <<ID:text>> records as ">"
(owner test 2026-10-13 17:00: 8 units -> ">>>>>>>>"), so the API asks for a code
block and the page script reads the code text exactly.

Runs the real login_provider_chatgpt.js + login_webchat_dom.js in Chromium on a
synthetic chatgpt.com page (no account, no network). Needs Playwright:
    python3 scripts/test-login-chatgpt-codeblock-10482.py
"""
import asyncio
import json
import sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ModuleNotFoundError:
    # Explicit, not silent: this check needs a browser and was not run here.
    print('{"skipped": "playwright is not installed for this Python; run with python3 that has Playwright"}')
    sys.exit(0)

ROOT = Path(__file__).resolve().parents[1]
PROVIDER = (ROOT / "src/content/login/webchat/login_provider_chatgpt.js").read_text(encoding="utf-8")
DOM = (ROOT / "src/content/login/webchat/login_webchat_dom.js").read_text(encoding="utf-8")
RECORDS = "<<I1_P0:ตอนต่อไป->>\n<<I1_P1:อยากเป็นพลังในเงา!>>\n<<I1_P2:ตอนที่ 23>>"

PAGE = """<!doctype html><meta charset=utf-8><body>
<button data-testid="accounts-profile-button">Kuju account</button>
<button data-testid="model-switcher-dropdown-button">ChatGPT</button>
<main id="chat"></main>
<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true" role="textbox"></div>
<button data-testid="send-button" type="submit">Send</button></form>
<script>
const MODE = location.hash.slice(1);
document.querySelector('form').addEventListener('submit', e => e.preventDefault());
document.querySelector('[data-testid=send-button]').addEventListener('click', () => {
  const chat = document.getElementById('chat'), composer = document.getElementById('prompt-textarea');
  const user = document.createElement('div'); user.setAttribute('data-message-author-role', 'user');
  user.textContent = composer.innerText; chat.append(user); composer.textContent = '';
  const stop = document.createElement('button'); stop.setAttribute('data-testid', 'stop-button'); stop.textContent = 'Stop';
  document.body.append(stop);
  setTimeout(() => {
    const answer = document.createElement('div'); answer.setAttribute('data-message-author-role', 'assistant');
    const markdown = document.createElement('div'); markdown.className = 'markdown';
    const raw = REPLY;
    if (MODE === 'code') {
      // How chatgpt.com shows a ```text block: a header with the language and a
      // copy button, then the code element with the exact text.
      markdown.innerHTML = '<pre><div><div>text</div><button>Copy code</button></div><div><code class="language-text"></code></div></pre>';
      markdown.querySelector('code').textContent = raw;
    } else {
      // Plain formatted text: the formatter drops anything that looks like a tag.
      markdown.innerHTML = '<p>' + raw.replace(/<<[^>]*>/g, '').replace(/\\n/g, '') + '</p>';
    }
    answer.append(markdown); chat.append(answer); stop.remove();
  }, 400);
});
</script>""".replace("REPLY", json.dumps(RECORDS))

STUB = """window.chrome = {runtime: {id: 'tp', lastError: null, sendMessage(m, cb) { cb && cb(); }, onMessage: {addListener() {}}}};"""


async def run(mode):
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=["--no-sandbox"])
        page = await (await browser.new_context()).new_page()

        async def route(r):
            if r.request.url.endswith("/api/auth/session"):
                await r.fulfill(status=200, content_type="application/json", body=json.dumps({"user": {"id": "user-qa"}}))
            else:
                await r.fulfill(status=200, content_type="text/html", body=PAGE)
        await page.route("https://chatgpt.com/**", route)
        await page.goto("https://chatgpt.com/#" + mode)
        await page.add_script_tag(content=STUB)
        await page.add_script_tag(content=PROVIDER)
        await page.add_script_tag(content=DOM)
        probe = await page.evaluate("TPWebchatDOM.probe('login_chatgpt')")
        assert probe["ready"], probe
        result = await page.evaluate("""fp => TPWebchatDOM.execute({provider: 'login_chatgpt', turnId: 't1',
            prompt: 'Translate these records\\n\\nReply format: code block', accountFingerprint: fp, modelLabel: ''})""",
                                     probe["accountFingerprint"])
        await browser.close()
        return result["text"]


async def main():
    code = await run("code")
    assert code == RECORDS, ("the code block text is read exactly", code)
    plain = await run("plain")
    assert plain == ">>>", ("plain formatted text loses the records, as seen on chatgpt.com", plain)
    print(json.dumps({"passed": 2, "checks": [
        "a ```text code block answer is read exactly, newlines and <<ID:text>> kept",
        "without a code block the formatted text loses the records (the 17:00 symptom)"]}, ensure_ascii=False))

asyncio.run(main())
