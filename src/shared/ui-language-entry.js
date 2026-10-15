import { createUiLanguageController } from './ui-language.js';
const host = document.querySelector('[data-tp-language-host]');
if (host) {
  const controller = createUiLanguageController({ host });
  // A narrow testing/debugging hook contains no settings, credentials or customer data.
  globalThis.__TP_UI_LANGUAGE = controller;
  addEventListener('pagehide', () => controller.dispose(), { once: true });
}
