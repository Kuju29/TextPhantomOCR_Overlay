import assert from "node:assert/strict";
import {
  imagesFromDirectoryHandle,
  pickImagesFromDirectory,
} from "../src/shared/local-gallery.js";

let txtGetFileCalls = 0;
let pngGetFileCalls = 0;
let nestedEnumerations = 0;

const directory = {
  name: "Chapter 01",
  async *values() {
    yield {
      kind: "file",
      name: "notes.txt",
      async getFile() {
        txtGetFileCalls++;
        return new File(["no"], "notes.txt", { type: "text/plain" });
      },
    };
    yield {
      kind: "directory",
      name: "nested",
      async *values() {
        nestedEnumerations++;
        yield { kind: "file", name: "hidden.jpg" };
      },
    };
    yield {
      kind: "file",
      name: "page01.png",
      async getFile() {
        pngGetFileCalls++;
        return new File([new Uint8Array([1, 2, 3])], "page01.png", { type: "image/png" });
      },
    };
  },
};

// Node 18 may not expose File globally; install a minimal compatible class.
if (typeof globalThis.File === "undefined") {
  globalThis.File = class File extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = name;
      this.lastModified = Date.now();
    }
  };
}

const direct = await imagesFromDirectoryHandle(directory);
assert.equal(direct.files.length, 1);
assert.equal(direct.files[0].name, "page01.png");
assert.equal(txtGetFileCalls, 0, "non-image filenames must never be opened with getFile()");
assert.equal(pngGetFileCalls, 1);
assert.equal(nestedEnumerations, 0, "subdirectories must never be traversed");
assert.equal(direct.subfolders, 1);

let pickerCalls = 0;
const picked = await pickImagesFromDirectory(async (options) => {
  pickerCalls++;
  assert.equal(options.mode, "read");
  return directory;
});
assert.equal(pickerCalls, 1);
assert.equal(picked.supported, true);
assert.equal(picked.files.length, 1);

const unsupported = await pickImagesFromDirectory(undefined);
assert.equal(unsupported.supported, false);

console.log("local directory picker tests passed");
