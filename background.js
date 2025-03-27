chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "fetchImageBlob") {
      fetch(message.url?.trim())
        .then(response => {
          if (!response.ok) {
            throw new Error("Network response was not ok");
          }
          return response.blob();
        })
        .then(blob => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64data = reader.result.split(',')[1];
            sendResponse({ success: true, blobData: base64data, mimeType: blob.type });
          };
          reader.readAsDataURL(blob);
        })
        .catch(error => {
          sendResponse({ success: false, error: error.message });
        });
      return true;
    }
  });
