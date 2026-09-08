import {
  filterImageFiles,
  pickImagesFromDirectory,
  saveLocalSession,
  sortLocalPages,
  toLocalPageRecord,
} from "../../shared/local-gallery.js";

export function createLocalPickerController({
  els,
  createTab,
  runtimeUrl,
  closeWindow,
  randomId,
}) {
  const report = (text) => {
    if (els.localPickerMsg) els.localPickerMsg.textContent = String(text || "");
  };

  const openSession = async (pages, sourceLabel) => {
    const session = await saveLocalSession({
      id: randomId(),
      createdAt: Date.now(),
      title: sourceLabel,
      pages,
    });
    await createTab({
      url: runtimeUrl(
        `viewer/viewer.html?sid=${encodeURIComponent(session.id)}`,
      ),
    });
    closeWindow();
  };

  const openFiles = async (fileList, sourceLabel) => {
    const picked = [...(fileList || [])];
    const topLevelOnly = sourceLabel === "folder";
    const images = filterImageFiles(picked, { topLevelOnly });
    if (!images.length) {
      const deeper = topLevelOnly
        ? filterImageFiles(picked, { topLevelOnly: false }).length
        : 0;
      report(
        deeper
          ? `No images directly in that folder. ${deeper} image(s) are in its subfolders, which this picker does not add.`
          : `Nothing was added: none of the ${picked.length} selected file(s) are images.`,
      );
      return;
    }
    report(`Opening ${images.length} image(s)…`);
    await openSession(
      sortLocalPages(
        images.map((file, index) => toLocalPageRecord(file, index)),
      ),
      sourceLabel,
    );
  };

  const chooseDirectory = async () => {
    let picked;
    try {
      picked = await pickImagesFromDirectory(
        typeof window.showDirectoryPicker === "function"
          ? window.showDirectoryPicker.bind(window)
          : undefined,
      );
    } catch (error) {
      report(
        `Could not open the folder picker: ${error?.message || String(error)}. In Brave, enable brave://flags/#file-system-access-api and relaunch the browser.`,
      );
      return;
    }
    if (!picked.supported) {
      report(
        "Brave has File System Access disabled. Enable brave://flags/#file-system-access-api and relaunch Brave.",
      );
      return;
    }
    if (picked.cancelled) return;
    if (!picked.files.length) {
      report(
        `No image files were found directly in “${picked.folderName || "that folder"}”.${picked.subfolders ? ` ${picked.subfolders} subfolder(s) were not opened.` : ""}`,
      );
      return;
    }
    report(
      `Opening ${picked.files.length} image(s) from “${picked.folderName || "folder"}”…`,
    );
    await openSession(
      sortLocalPages(
        picked.files.map((file, index) =>
          toLocalPageRecord(file, index, picked.relativePaths?.[index] || ""),
        ),
      ),
      "folder",
    );
  };

  const bind = () => {
    els.openLocalImages?.addEventListener("click", () => {
      report("");
      if (els.localImagesInput) els.localImagesInput.value = "";
      els.localImagesInput?.click();
    });
    els.openLocalFolder?.addEventListener("click", () => {
      report("");
      void chooseDirectory();
    });
    els.localImagesInput?.addEventListener("change", () => {
      const files = [...(els.localImagesInput?.files || [])];
      if (els.localImagesInput) els.localImagesInput.value = "";
      void openFiles(files, "images");
    });
  };

  return { bind };
}
