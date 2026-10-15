/** Consumer Gemini; no Cloud project or Google API billing. */
(() => { (globalThis.TPWebchatProviders ||= {}).login_gemini = {
  id:"login_gemini", origin:"https://gemini.google.com", newChatUrl:"https://gemini.google.com/app",
  composer:['rich-textarea .ql-editor[contenteditable="true"]','.ql-editor[contenteditable="true"]'],
  send:['button.send-button','button[aria-label*="Send" i]'], stop:['button[aria-label*="Stop" i]'],
  user:['user-query','.user-query'], assistant:['model-response','.model-response','[data-test-id="model-response"]'],
  final:['.markdown','message-content'],
  account:['a[aria-label*="Google Account" i]','button[aria-label*="Google Account" i]','a[aria-label*="บัญชี Google"]'],
  model:['button[aria-label*="model" i]','button[data-test-id="bard-mode-menu-button"]','.bard-mode-menu-button'], offMode:/\bFast\b|รวดเร็ว/i,
}; })();
