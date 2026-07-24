/**
 * Thunderbird-only integration for displayed email messages.
 *
 * Normal WebExtension content_scripts cover web tabs. Thunderbird 128+ uses
 * scripting.messageDisplay for scripts that run inside displayed messages.
 * The module is feature-detected and is therefore a no-op in web browsers.
 */

const MESSAGE_SCRIPT_ID = "textphantom-message-display";

const MESSAGE_DISPLAY_SCRIPTS = [
  "shared/compat.js",
  "content/namespace.js",
  "content/keepalive.js",
  "content/dom-utils.js",
  "content/image-finder.js",
  "content/payload.js",
  "content/overlay.js",
  "content/image-buttons.js",
  "content/site-mangadex.js",
  "content/mangadex.js",
  "content/messaging.js",
  "content/index.js",
];

let registrationPromise = null;

export function ensureThunderbirdMessageScripts() {
  const api = globalThis.messenger || globalThis.browser;
  const messageDisplay = api?.scripting?.messageDisplay;
  if (!messageDisplay) return Promise.resolve(false);
  if (registrationPromise) return registrationPromise;

  registrationPromise = (async () => {
    const existing = await messageDisplay.getRegisteredScripts({
      ids: [MESSAGE_SCRIPT_ID],
    });
    const current = Array.isArray(existing) ? existing[0] : null;
    const currentFiles = Array.isArray(current?.js) ? current.js : [];
    const isCurrent =
      currentFiles.length === MESSAGE_DISPLAY_SCRIPTS.length &&
      currentFiles.every((file, index) => file === MESSAGE_DISPLAY_SCRIPTS[index]);

    if (!isCurrent && current) {
      await messageDisplay.unregisterScripts({ ids: [MESSAGE_SCRIPT_ID] });
    }
    if (!isCurrent) {
      await messageDisplay.registerScripts([
        {
          id: MESSAGE_SCRIPT_ID,
          js: MESSAGE_DISPLAY_SCRIPTS,
          runAt: "document_start",
        },
      ]);
    }
    return true;
  })().catch((error) => {
    registrationPromise = null;
    throw error;
  });

  return registrationPromise;
}
