import {
  filterImageFiles,
  isBraveBrowser,
  pickImagesFromDirectory,
  popupFileDialogClosesPopup,
  saveLocalSession,
  sortLocalPages,
  toLocalPageRecord,
} from "../../shared/local-gallery.js";
import { setUiTemplate } from "../../shared/ui-template.js";

export function createLocalPickerController({
  els,
  createTab,
  runtimeUrl,
  closeWindow,
  randomId,
  notifyBackground,
}) {
  // values: `text` is a registered UI template; runtime values stay protected.
  const report = (text, values) => {
    if (!els.localPickerMsg) return;
    if (values) setUiTemplate(els.localPickerMsg, text, values);
    else els.localPickerMsg.textContent = String(text || "");
  };

  const openSession = async (pages, sourceLabel) => {
    const session = await saveLocalSession({
      id: randomId(),
      createdAt: Date.now(),
      title: sourceLabel,
      pages,
    });
    // Lets the background sweep sessions abandoned before their tab attached
    // (it never deletes one younger than its grace period, like this one).
    notifyBackground?.({ type: "TP_LOCAL_SESSION_CREATED" });
    await createTab({
      url: runtimeUrl(
        `viewer/viewer.html?sid=${encodeURIComponent(session.id)}`,
      ),
    });
    closeWindow();
  };

  // An empty Local viewer tab: its own Select images / Select folder buttons
  // and folder drag-and-drop work in a normal tab where the popup cannot.
  const openEmptyViewer = async (pick) => {
    await createTab({
      url: runtimeUrl(`viewer/viewer.html?pick=${encodeURIComponent(pick)}`),
    });
    closeWindow();
  };
  const dialogClosesPopup = popupFileDialogClosesPopup(runtimeUrl(""));

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
          ? "No images directly in that folder. {count} image(s) are in its subfolders, which this picker does not add."
          : "Nothing was added: none of the {count} selected file(s) are images.",
        { count: deeper || picked.length },
      );
      return;
    }
    report("Opening {count} image(s)…", { count: images.length });
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
        "Could not open the folder picker: {error}. In Brave, enable brave://flags/#file-system-access-api and relaunch the browser.",
        { error: error?.message || String(error) },
      );
      return;
    }
    if (!picked.supported) {
      // Only Brave can turn the API on. Elsewhere (no folder picker at all)
      // the Local viewer tab still takes a dragged folder.
      if (isBraveBrowser())
        report(
          "Brave has File System Access disabled. Enable brave://flags/#file-system-access-api and relaunch Brave.",
        );
      else await openEmptyViewer("folder");
      return;
    }
    if (picked.cancelled) return;
    if (!picked.files.length) {
      report(
        picked.subfolders
          ? "No image files were found directly in “{folder}”. {count} subfolder(s) were not opened."
          : "No image files were found directly in “{folder}”.",
        { folder: picked.folderName || "that folder", count: picked.subfolders },
      );
      return;
    }
    report("Opening {count} image(s) from “{folder}”…", {
      count: picked.files.length,
      folder: picked.folderName || "folder",
    });
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
      if (dialogClosesPopup) return void openEmptyViewer("images");
      if (els.localImagesInput) els.localImagesInput.value = "";
      els.localImagesInput?.click();
    });
    els.openLocalFolder?.addEventListener("click", () => {
      report("");
      if (dialogClosesPopup) return void openEmptyViewer("folder");
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
