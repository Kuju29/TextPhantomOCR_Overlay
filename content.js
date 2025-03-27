(function () {
  let shouldStop = false;
  let isRunning = false;

  function log(msg) {
      console.log(msg);
      try {
          if (chrome?.runtime?.id) {
              chrome.runtime.sendMessage({ type: "log", data: msg });
          }
      } catch (err) {
          console.warn("Log skipped (extension context lost):", msg);
      }
  }

  const style = document.createElement("style");
  style.textContent = `
    .ocr-overlay-container:not(.ocr-visible) {
      display: none !important;
    }
  `;
  document.head.appendChild(style);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.command === "start") {
          shouldStop = false;
          isRunning = true;
          log("OCR started");
          processImages();
          updateOverlayButton(true);
          sendResponse({ running: true });
      } else if (message.command === "stop") {
          shouldStop = true;
          isRunning = false;
          log("OCR stopped");
          updateOverlayButton(false);
        sendResponse({ running: false });
      } else if (message.command === "showUIOverlay") {
          createPersistentOverlayUI();
          sessionStorage.setItem("ocr-ui-visible", "true");
          log("Extension UI shown.");
      } else if (message.command === "hideUIOverlay") {
          const ui = document.getElementById("ocr-extension-ui");
          if (ui) ui.remove();
          sessionStorage.setItem("ocr-ui-visible", "false");
          log("Extension UI hidden.");
      } else if (message.command === "getOverlayStatus") {
          const isUIVisible = !!document.getElementById("ocr-extension-ui");
          sendResponse({ isUIVisible });
      } else if (message.command === "getOCRStatus") {
        sendResponse({ running: isRunning });
      }
  });

  function createPersistentOverlayUI() {
      if (document.getElementById("ocr-extension-ui")) return;

      const ui = document.createElement("div");
      ui.id = "ocr-extension-ui";
      ui.style.position = "fixed";
      ui.style.top = "20px";
      ui.style.right = "20px";
      ui.style.background = "rgba(30, 30, 30, 0.95)";
      ui.style.color = "white";
      ui.style.padding = "10px";
      ui.style.borderRadius = "8px";
      ui.style.zIndex = "999999";
      ui.style.fontSize = "14px";
      ui.style.boxShadow = "0 0 10px rgba(0,0,0,0.4)";
      ui.innerHTML = `
        <div style="margin-bottom: 6px;"><strong>OCR Extension</strong></div>
        <button id="ocr-start-btn" style="margin-bottom: 4px;">▶️ Start OCR</button><br/>
        <button id="ocr-hide-btn">❌ Hide UI</button>
      `;

      document.body.appendChild(ui);

      const startButton = document.getElementById("ocr-start-btn");
      startButton.onclick = () => {
          isRunning = !isRunning;
          const command = isRunning ? "start" : "stop";
          updateOverlayButton(isRunning);
          window.postMessage({ type: "FROM_UI", command: command }, "*");
      };

      updateOverlayButton(isRunning);

      document.getElementById("ocr-hide-btn").onclick = () => {
          ui.remove();
          sessionStorage.setItem("ocr-ui-visible", "false");
      };
  }

  function updateOverlayButton(running) {
    const startButton = document.getElementById("ocr-start-btn");
    if (startButton) {
        startButton.textContent = running ? "⏹ Stop OCR" : "▶️ Start OCR";
    }
 }

  function removeLazyScriptsAndForceSrc() {
      const lazyScripts = document.querySelectorAll('script[src*="lazy"]');
      lazyScripts.forEach(script => script.remove());

      const lazyImgs = document.querySelectorAll('img[data-src]');
      lazyImgs.forEach(img => {
          img.removeAttribute('loading');
          img.classList.remove('lazyload', 'lazy', 'lazyloaded');
          if (img.dataset.src) {
              img.src = img.dataset.src;
          }
      });
      log("Lazy loading removed and src set from data-src");
  }

  function isValidImage(src) {
      if (!src || typeof src !== "string") return false;

      if (!/^https?:\/\//i.test(src)) {
          return false;
      }

      const lower = src.toLowerCase();
      return (
          lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') ||
          lower.endsWith('.png') ||
          lower.endsWith('.webp')
      );
  }

  async function sendImageToOCR(file) {
      const formData = new FormData();
      formData.append("image", file);
      try {
          const response = await fetch("http://127.0.0.1:5000/ocr", {
              method: "POST",
              body: formData,
          });
          if (!response.ok) {
              log("OCR API error: " + response.statusText);
              return null;
          }
          return await response.json();
      } catch (error) {
          log("OCR API request failed: " + error);
          return null;
      }
  }

  function fetchImageBlobViaBackground(url) {
      return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "fetchImageBlob", url }, (response) => {
              if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
              if (response && response.success) {
                  const binary = atob(response.blobData);
                  const len = binary.length;
                  const bytes = new Uint8Array(len);
                  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
                  const blob = new Blob([bytes], { type: response.mimeType });
                  resolve(blob);
              } else {
                  reject(new Error("Image blob fetch failed"));
              }
          });
      });
  }

  async function removeTextWithCanvas(ctx, x0, y0, x1, y1) {
      const margin = 2;
      const left = Math.max(0, x0 - margin);
      const top = Math.max(0, y0 - margin);
      const width = (x1 - x0) + margin * 2;
      const height = (y1 - y0) + margin * 2;
      ctx.save();
      ctx.filter = 'blur(10px)';
      ctx.drawImage(ctx.canvas, left, top, width, height, left, top, width, height);
      ctx.restore();
  }

  async function updateImageRemoveText(imgElement, textAnnotations, blob) {
      const safeUrl = URL.createObjectURL(blob);
      const originalImage = new Image();
      originalImage.crossOrigin = "Anonymous";
      originalImage.src = safeUrl;
      await originalImage.decode();

      const w = originalImage.naturalWidth;
      const h = originalImage.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(originalImage, 0, 0, w, h);

      for (const annotation of textAnnotations) {
          const vertices = annotation.boundingPoly.vertices;
          if (vertices && vertices.length === 4) {
              const xValues = vertices.map(v => v.x);
              const yValues = vertices.map(v => v.y);
              const x0 = Math.min(...xValues);
              const y0 = Math.min(...yValues);
              const x1 = Math.max(...xValues);
              const y1 = Math.max(...yValues);
              await removeTextWithCanvas(ctx, x0, y0, x1, y1);
          }
      }

      const dataUrl = canvas.toDataURL("image/png");
      URL.revokeObjectURL(safeUrl);
      return dataUrl;
  }

  function overlayTextOnImage(imgElement, annotationsData) {
      const annotations = annotationsData.textAnnotations || annotationsData;

      const container = document.createElement("div");
      container.classList.add("ocr-overlay-container", "ocr-visible");
      container.style.position = "relative";
      container.style.display = "inline-block";
      container.style.width = imgElement.clientWidth + "px";
      container.style.height = imgElement.clientHeight + "px";
      imgElement.parentNode.insertBefore(container, imgElement);
      container.appendChild(imgElement);
      imgElement.style.display = "block";

      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.top = "0";
      overlay.style.left = "0";
      overlay.style.width = "100%";
      overlay.style.height = "100%";
      overlay.style.pointerEvents = "none";
      container.appendChild(overlay);

      const scaleX = imgElement.clientWidth / imgElement.naturalWidth;
      const scaleY = imgElement.clientHeight / imgElement.naturalHeight;

      function applyScaledStyle(element, styleStr, scaleX, scaleY) {
          const styleProps = {};
          styleStr.split(";").forEach(item => {
              if (item.trim()) {
                  const parts = item.split(":");
                  if (parts.length === 2) {
                      const key = parts[0].trim();
                      const value = parts[1].trim();
                      styleProps[key] = value;
                  }
              }
          });
          if (styleProps.top) {
              const topVal = parseFloat(styleProps.top);
              element.style.top = (topVal * scaleY) + "px";
          }
          if (styleProps.left) {
              const leftVal = parseFloat(styleProps.left);
              element.style.left = (leftVal * scaleX) + "px";
          }
          if (styleProps.width) {
              const widthVal = parseFloat(styleProps.width);
              element.style.width = (widthVal * scaleX) + "px";
          }
          if (styleProps.height) {
              const heightVal = parseFloat(styleProps.height);
              element.style.height = (heightVal * scaleY) + "px";
          }
          if (styleProps.transform) {
              element.style.transform = styleProps.transform;
          }
      }

      annotations.forEach(annotation => {
        const textDiv = document.createElement("div");
        textDiv.style.position = "absolute";
        applyScaledStyle(textDiv, annotation.style, scaleX, scaleY);
        textDiv.style.pointerEvents = "none";
        textDiv.style.display = "table";
        textDiv.style.zIndex = "9999";
        
        const textSpan = document.createElement("span");
        textSpan.textContent = annotation.description;
        textSpan.style.display = "table-cell";
        textSpan.style.width = "100%";
        textSpan.style.height = "100%";
        textSpan.style.backgroundColor = "rgba(255, 255, 255, 0.5)";
        textSpan.style.color = "red";
        textSpan.style.textAlign = "center";
        textSpan.style.verticalAlign = "middle";
        textSpan.style.lineHeight = "normal";
        textSpan.style.whiteSpace = "pre-line";
        
          textDiv.appendChild(textSpan);
          overlay.appendChild(textDiv);
      });
  }

  async function processImages() {
      removeLazyScriptsAndForceSrc();

      const imgElements = Array.from(document.querySelectorAll("img"))
          .filter(img => isValidImage(img.src));

      const batchSize = 10;
      for (let i = 0; i < imgElements.length; i += batchSize) {
          if (shouldStop) {
              log("OCR interrupted");
              break;
          }

          const batch = imgElements.slice(i, i + batchSize);

          const batchTasks = batch.map(img => (async () => {
            if (shouldStop) return;
        
            const src = img.src;
        
            if (!isValidImage(src)) {
                log(`❌ Invalid URL skipped: ${src}`);
                return;
            }
        
            try {
                const blob = await fetchImageBlobViaBackground(src);
                if (shouldStop) return;
        
                if (!blob) {
                    log(`❌ Failed to fetch blob: ${src}`);
                    return;
                }
        
                const file = new File([blob], "image.jpg", { type: blob.type });
                const ocrResult = await sendImageToOCR(file);
                if (shouldStop) return;
        
                if (!ocrResult || !ocrResult.textAnnotations) {
                    log(`⚠️ No OCR result for: ${src}`);
                    return;
                }
        
                const newDataURL = await updateImageRemoveText(img, ocrResult.textAnnotations, blob);
                if (shouldStop) return;
        
                img.src = newDataURL;
        
                overlayTextOnImage(img, ocrResult);
                log(`✅ Processed: ${src}`);
            } catch (err) {
                log(`❌ Error processing ${src}: ${err}`);
            }
        })());     

        await Promise.all(batchTasks);
        log(`📦 Finished batch ${Math.floor(i / batchSize) + 1}`);

      }
      log("🎉 All image batches processed.");
      isRunning = false;
      const startButton = document.getElementById("ocr-start-btn");
      if (startButton) {
          startButton.textContent = "▶️ Start OCR";
      }
      updateOverlayButton(false); 
      chrome.runtime.sendMessage({ type: "ocrFinished" });
  }

  window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.data.type === "FROM_UI") {
          if (event.data.command === "start") {
              shouldStop = false;
              isRunning = true;
              log("OCR started from UI overlay.");
              processImages();
              const startButton = document.getElementById("ocr-start-btn");
              if(startButton){
                  startButton.textContent = "⏹ Stop OCR";
              }
          }
          else if (event.data.command === "stop") {
              shouldStop = true;
              isRunning = false;
              log("OCR stopped from UI overlay.");
              const startButton = document.getElementById("ocr-start-btn");
              if(startButton){
                  startButton.textContent = "▶️ Start OCR";
              }
          }
      }
  });

  const observer = new MutationObserver(() => {
      const shouldShow = sessionStorage.getItem("ocr-ui-visible");
      const uiAlreadyExists = !!document.getElementById("ocr-extension-ui");

      if (shouldShow === "true" && !uiAlreadyExists) {
          createPersistentOverlayUI();
          log("UI auto-restored via MutationObserver.");
      }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
