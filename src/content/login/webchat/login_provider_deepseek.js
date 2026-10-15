/** DeepSeek website selectors; require final-answer completion evidence. */
(() => { (globalThis.TPWebchatProviders ||= {}).login_deepseek = {
  id:"login_deepseek", origin:"https://chat.deepseek.com", newChatUrl:"https://chat.deepseek.com/",
  composer:['textarea#chat-input','textarea.ds-scroll-area','textarea[class*="ds-"]'],
  send:['button[aria-label*="Send" i]','[role="button"][aria-label*="Send" i]'],
  stop:['button[aria-label*="Stop" i]','[role="button"][aria-label*="Stop" i]'],
  user:['[data-role="user"]','.ds-chat-message-content[data-role="user"]'],
  assistant:['[data-role="assistant"]','.ds-chat-message-content[data-role="assistant"]','.ds-markdown'],
  final:['.ds-markdown'], account:['button[aria-label*="profile" i]','button[aria-label*="account" i]'],
  model:['button[aria-label*="model" i]'],
}; })();
