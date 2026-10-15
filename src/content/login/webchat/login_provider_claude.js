/** Consumer Claude normal-tab adapter description. */
(() => { (globalThis.TPWebchatProviders ||= {}).login_claude = {
  id:"login_claude", origin:"https://claude.ai", newChatUrl:"https://claude.ai/new",
  composer:['.ProseMirror[contenteditable="true"]','[data-testid="chat-input"]'],
  send:['button[aria-label*="Send" i]'], stop:['[data-testid*="stop-generating"]','button[aria-label*="Stop" i]','button[title*="Stop" i]'],
  user:['[data-testid="user-message"]','[data-testid="human-message"]','article[data-author="user"]'],
  assistant:['[data-testid="assistant-message"]','.font-claude-response','article[data-author="assistant"]'], final:['.font-claude-response'],
  account:['button[data-testid="user-menu-button"]','button[aria-label*="profile" i]','button[aria-label*="account" i]'],
  model:['button[data-testid="model-selector-dropdown"]','button[aria-label*="model" i]'],
}; })();
