import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compatSource = await readFile(
  path.join(projectRoot, "src/shared/compat.js"),
  "utf8",
);

const event = { addListener() {} };
const messenger = {
  runtime: {
    onConnect: event,
    onInstalled: event,
    onMessage: event,
    onStartup: event,
    connect: () => ({ name: "port" }),
    getManifest: () => ({ version: "test" }),
    getURL: (value) => `moz-extension://test/${value}`,
    sendMessage: async (message) => ({ echoed: message }),
  },
  storage: {
    local: {
      get: async () => ({ mode: "lens_images" }),
      set: async () => undefined,
      remove: async () => undefined,
      clear: async () => undefined,
    },
    onChanged: event,
  },
  tabs: {
    onRemoved: event,
    onUpdated: event,
    create: async (properties) => ({ id: 2, ...properties }),
    get: async (id) => ({ id }),
    query: async () => [{ id: 1 }],
    sendMessage: async (_id, message) => ({ echoed: message }),
  },
  menus: {
    onClicked: event,
    create: (properties) => properties.id,
    removeAll: async () => undefined,
  },
  scripting: { messageDisplay: {} },
};

const context = vm.createContext({
  console,
  messenger,
  Promise,
  Object,
  String,
});
vm.runInContext(compatSource, context, { filename: "shared/compat.js" });

assert.ok(context.chrome, "Thunderbird adapter did not create chrome namespace");
assert.equal(context.chrome.runtime.getManifest().version, "test");
assert.equal(context.chrome.contextMenus.create({ id: "menu" }), "menu");

const queried = await new Promise((resolve) => {
  context.chrome.tabs.query({ active: true }, resolve);
});
assert.equal(queried[0].id, 1);

const stored = await new Promise((resolve) => {
  context.chrome.storage.local.get(["mode"], resolve);
});
assert.equal(stored.mode, "lens_images");

const response = await new Promise((resolve) => {
  context.chrome.runtime.sendMessage({ type: "PING" }, resolve);
});
assert.equal(response.echoed.type, "PING");

await new Promise((resolve) => context.chrome.contextMenus.removeAll(resolve));

console.log("Thunderbird callback compatibility test passed.");
