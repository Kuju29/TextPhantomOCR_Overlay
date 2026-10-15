/** Consumer ChatGPT DOM candidates; bundled code, no remote scripts. */
(() => { (globalThis.TPWebchatProviders ||= {}).login_chatgpt = {
  id:"login_chatgpt", origin:"https://chatgpt.com", newChatUrl:"https://chatgpt.com/",
  composer:['#prompt-textarea','div.ProseMirror[contenteditable="true"]','form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]','form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]','[contenteditable="true"][data-lexical-editor="true"]'],
  send:['button[data-testid="send-button"]','button[aria-label="Send" i]','button[aria-label="Send message" i]','button[aria-label="Send prompt" i]'], stop:['[data-testid="stop-button"]','button[aria-label*="Stop" i]'],
  user:['[data-message-author-role="user"]','[data-chatgpt-search-unit-key$=":user"]','[data-user-message-bubble]','[data-conversation-role="user"]'],
  assistant:['[data-message-author-role="assistant"]','[data-chatgpt-search-unit-key$=":assistant"]','[data-conversation-role="assistant"]','[data-markdown-text-style="assistant-message"]'],
  final:['[data-markdown-text-style="assistant-message"]','.markdown'],
  account:['[data-testid="accounts-profile-button"]','button[aria-label*="profile" i]'],
  model:['button[data-testid="model-switcher-dropdown-button"]'], offMode:/\bInstant\b/i,
}; })();
