let isRunning = false;
let isOverlayVisible = true;

function checkOverlayStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.tabs.sendMessage(tabs[0].id, { command: "getOverlayStatus" }, (response) => {
        if (response) {
          isOverlayVisible = response.isUIVisible;
          document.getElementById("toggleOverlay").textContent = isOverlayVisible
            ? "👁 Hide UI Overlay"
            : "👁 Show UI Overlay";
        }
      });
    });
  }

  function checkOCRStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.tabs.sendMessage(tabs[0].id, { command: "getOCRStatus" }, (response) => {
        if (response && typeof response.running === "boolean") {
          isRunning = response.running;
          document.getElementById("toggleOCR").textContent = isRunning ? "⏹ Stop OCR" : "▶️ Start OCR";
        }
      });
    });
  }  

function sendCommand(command) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        chrome.tabs.sendMessage(tabs[0].id, { command });
    });
}

function sendCommandWithStateUpdate(command) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(tabs[0].id, { command }, (response) => {
      if (response && response.running !== undefined) {
        isRunning = response.running;
        document.getElementById("toggleOCR").textContent = isRunning ? "⏹ Stop OCR" : "▶️ Start OCR";
      }
    });
  });
}

document.getElementById("toggleOCR").addEventListener("click", () => {
  isRunning = !isRunning;
  const command = isRunning ? "start" : "stop";
  document.getElementById("toggleOCR").textContent = isRunning ? "⏹ Stop OCR" : "▶️ Start OCR";
  sendCommandWithStateUpdate(command);
});

document.getElementById("toggleOverlay").addEventListener("click", () => {
    isOverlayVisible = !isOverlayVisible;
    const command = isOverlayVisible ? "showUIOverlay" : "hideUIOverlay";
    document.getElementById("toggleOverlay").textContent = isOverlayVisible ? "👁 Hide UI Overlay" : "👁 Show UI Overlay";
    sendCommand(command);
  });  

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "log") {
    const logArea = document.getElementById("log");
    logArea.textContent += message.data + "\n";
    logArea.scrollTop = logArea.scrollHeight;
  } else if (message.type === "ocrFinished") {
    isRunning = false;
    const toggleBtn = document.getElementById("toggleOCR");
    if (toggleBtn) toggleBtn.textContent = "▶️ Start OCR";
  }
});

document.addEventListener("DOMContentLoaded", () => {
    checkOverlayStatus();
    checkOCRStatus(); 
  });
  