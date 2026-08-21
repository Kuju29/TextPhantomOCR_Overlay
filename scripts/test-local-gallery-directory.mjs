import assert from "node:assert/strict";
import {
  hasImageExtension,
  imagesFromDirectoryHandle,
  pickImageDirectory,
} from "../src/shared/local-gallery.js";

assert.equal(hasImageExtension("page01.JPG"), true);
assert.equal(hasImageExtension("page02.webp"), true);
assert.equal(hasImageExtension("notes.txt"), false);
assert.equal(hasImageExtension("image.jpg.exe"), false);

let imageReads = 0;
let nonImageReads = 0;
const imageFile = new File(["fake-image"], "page10.png", { type: "image/png" });
const webpFile = new File(["fake-webp"], "page2.webp", { type: "" });

const handle = {
  name: "chapter-1",
  async *values() {
    yield {
      kind: "file",
      name: "page10.png",
      async getFile() {
        imageReads++;
        return imageFile;
      },
    };
    yield {
      kind: "file",
      name: "notes.txt",
      async getFile() {
        nonImageReads++;
        return new File(["secret"], "notes.txt", { type: "text/plain" });
      },
    };
    yield { kind: "directory", name: "extras" };
    yield {
      kind: "file",
      name: "page2.webp",
      async getFile() {
        imageReads++;
        return webpFile;
      },
    };
  },
};

const result = await imagesFromDirectoryHandle(handle);
assert.equal(result.folderName, "chapter-1");
assert.deepEqual(result.files.map((file) => file.name), ["page10.png", "page2.webp"]);
assert.deepEqual(result.relativePaths, ["chapter-1/page10.png", "chapter-1/page2.webp"]);
assert.equal(result.scanned, 3);
assert.equal(result.skipped, 1);
assert.equal(result.subfolders, 1);
assert.equal(imageReads, 2);
assert.equal(nonImageReads, 0, "non-image file contents must never be opened");

const unsupported = await pickImageDirectory();
assert.equal(unsupported.supported, false);
assert.equal(unsupported.cancelled, false);

console.log("local gallery directory tests passed");
