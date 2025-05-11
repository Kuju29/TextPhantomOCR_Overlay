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

function loadSettings(cb) {
  chrome.storage.sync.get({ mode: 'google_images', language: 'th' }, cb);
}
function saveSettings(settings) {
  chrome.storage.sync.set(settings);
}

document.addEventListener('DOMContentLoaded', () => {
  const modeSelect = document.getElementById('modeSelect');
  const langContainer = document.getElementById('langContainer');
  const langSelect = document.getElementById('langSelect');
  const toggleBtn = document.getElementById('toggleOCR');

  chrome.storage.sync.get(
    { mode: 'google_images', language: 'th' },
    ({ mode, language }) => {
      modeSelect.value = mode;
      langSelect.value = language;
      langContainer.style.display = mode === 'google_images' ? 'block' : 'none';
      toggleBtn.textContent = '▶️ Start OCR';
    }
  );

  modeSelect.addEventListener('change', () => {
    const m = modeSelect.value;
    chrome.storage.sync.set({ mode: m });
    langContainer.style.display = m === 'google_images' ? 'block' : 'none';
  });

  langSelect.addEventListener('change', () => {
    chrome.storage.sync.set({ language: langSelect.value });
  });

  let isRunning = false;
  toggleBtn.addEventListener('click', () => {
    chrome.storage.sync.get(
      { mode: 'google_images', language: 'th' },
      ({ mode, language }) => {
        isRunning = !isRunning;
        const cmd = isRunning ? 'start' : 'stop';
        chrome.tabs.query(
          { active: true, currentWindow: true },
          (tabs) => {
            chrome.tabs.sendMessage(
              tabs[0].id,
              { command: cmd, mode, language },
              (resp) => {
                isRunning = resp.running;
                toggleBtn.textContent = isRunning
                  ? '⏹ Stop OCR'
                  : '▶️ Start OCR';
              }
            );
          }
        );
      }
    );
  });

  checkOverlayStatus();
  checkOCRStatus();
});

  
