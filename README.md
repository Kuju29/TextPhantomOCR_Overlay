[![Website](https://img.shields.io/badge/Website-kuju29.github.io-blue?style=flat-square&logo=github&logoColor=white)](https://kuju29.github.io/)

![Desktop2026 02 06-08 11 52 01-ezgif com-video-to-gif-converter](https://github.com/user-attachments/assets/43cc9a1e-eb79-46f0-b4a1-08ca9bcd49f5)

# ✨ TextPhantomOCR Overlay 
[![Installation](https://img.shields.io/badge/-Installation-red.svg?logo=youtube&labelColor=555555&style=for-the-badge)](https://www.youtube.com/watch?v=WQ7p7zsz_kc "Installation Guide") [![Run API Online](https://img.shields.io/badge/-Run_API_Online-blue.svg?logo=youtube&labelColor=555555&style=for-the-badge)](https://www.youtube.com/watch?v=NMHwaI8mn4c "Run API Online")

## 📥 Download & Install Options

| Version  | Extension Download | API Download | Note |
|----------|-------------------|--------------|------|
| [<img width="40" height="20" alt="image" src="https://brave.com/static-assets/images/brave-logo-sans-text.svg" />](https://chromewebstore.google.com/detail/cjbaepobgmickhgebgagklfcfacbbpem?utm_source=item-share-cb) [<img width="20" height="20" alt="image" src="https://www.google.com/chrome/static/images/chrome-logo-m100.svg" />](https://chromewebstore.google.com/detail/cjbaepobgmickhgebgagklfcfacbbpem?utm_source=item-share-cb) | [![Install Extension](https://img.shields.io/badge/Install%20from-%20Web%20Store-yellow?logo=googlechrome)](https://chromewebstore.google.com/detail/cjbaepobgmickhgebgagklfcfacbbpem?utm_source=item-share-cb) | [![Run API from Hugging Face](https://img.shields.io/badge/Run%20API%20from-Hugging%20Face-blue?logo=huggingface)](https://huggingface.co/spaces/plan291037/TextPhantom-v4.0.0/tree/main) | Easiest option, but still requires API |
| **[v4.0.1](https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/v4.0.1)** | [![Install Extension](https://img.shields.io/badge/Download%20ZIP%20from-Source%20Code-yellow?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/archive/refs/tags/v4.0.1.zip) | [![Run API from Hugging Face](https://img.shields.io/badge/Run%20API%20from-Hugging%20Face-blue?logo=huggingface)](https://huggingface.co/spaces/plan291037/TextPhantom-v4.0.0/tree/main) | Manual install |
| **[v3.0.1](https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/v3.0.1)** | [![Install Extension](https://img.shields.io/badge/Download%20ZIP%20from-Source%20Code-yellow?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/archive/refs/tags/v3.0.1.zip) | [![Run API from Hugging Face](https://img.shields.io/badge/Run%20API%20from-Hugging%20Face-blue?logo=huggingface)](https://huggingface.co/spaces/plan291037/TextPhantom_OCR_API2/tree/main) | Manual install |
| **[v2.0.2](https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/backup_V2.0.2)** | [![Install Extension](https://img.shields.io/badge/Download%20ZIP%20from-Source%20Code-yellow?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/archive/refs/tags/backup_V2.0.2.zip) | [![Download API](https://img.shields.io/badge/Download-API%20v2.0.2-blue?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/releases/tag/v2.0.2) | Manual install |
| **[v1.0.1](https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/v1.0.1)** | [![Install Extension](https://img.shields.io/badge/Download%20ZIP%20from-Source%20Code-yellow?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/archive/refs/tags/v1.0.1.zip) | [![Download API](https://img.shields.io/badge/Download-API%20v1.0.1-blue?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/releases/tag/v1.0.1) | Manual install |

##  1. Extension Installation

#### **Option – Chrome Web Store**
1. Install from [Chrome Web Store](https://chromewebstore.google.com/detail/cjbaepobgmickhgebgagklfcfacbbpem?utm_source=item-share-cb).  

### **Option – Manual Install**
1. Download and extract the **Source Code** for your version.  
2. Open Chrome → Go to `chrome://extensions/`.  
3. Enable **Developer Mode** (top right).  
4. Click **Load unpacked**.  
5. Select the extracted folder.  

##  2. Hugging Face API

### **Option - Public API**

1. Install and open **TextPhantom**.
2. Click **Refresh API URL**.
3. **Start translating! 🎉**

> Shared with other users, so it may be slower during high usage.

### **Option - Your Own API**

1. Open the [TextPhantom Hugging Face Space](https://huggingface.co/spaces/plan291037/TextPhantom-v4.0.0/tree/main).
2. Click **⋯ → Duplicate this Space**.
3. Wait until **Running**.
4. Click **⋯ → Embed this Space** and copy the URL.
5. Paste it into **Custom API URL**.

> Free cloned Spaces may stop automatically after being unused for up to 48 hours.

##  3. Getting Started with the Extension
  - Navigate to the page you want to translate.  
  - **Right-click** anywhere → choose **🔍 Translate...** from the context menu.

## 🤖 AI Translation for free

### **Option - Local AI: Ollama**

Run AI directly on your computer. **Free and no API key required.**

1. **Install Ollama**
   https://ollama.com/download

2. **Allow the extension to connect**
   Open PowerShell:

   ```powershell
   $env:OLLAMA_ORIGINS="chrome-extension://*"
   ```

3. **Install an AI model**

   ```powershell
   ollama pull gemma3
   ```

4. Open **TextPhantom → Local AI** and click **Connect**.

5. Select your installed model → **Start translating! 🎉**

> Ollama must be running while using Local AI.

---

### **Option - Cloud AI: Hugging Face**

Run AI on **Hugging Face's cloud servers**. No local AI installation or powerful GPU is required.

1. **Create / log in to Hugging Face**
   https://huggingface.co/login

2. **Enable access to Google Gemma**
   https://huggingface.co/google/gemma-3-27b-it
   Click **Agree and access**.

3. **Create an API Token**
   https://huggingface.co/settings/tokens

4. Enable:

   * ✅ **Read access to contents of all public gated repos you can access**

5. Copy the token and paste it into **TextPhantom → Hugging Face API Key**.

6. Select **Google Gemma** → **Start translating! 🎉**

> Hugging Face runs the AI in the cloud, so your computer does not need to run the model locally.



## 🖼️ DEMO / UI PREVIEW

<p align="center">
  <img src="https://github.com/user-attachments/assets/52135c1a-ba52-46e7-9174-9fdd1cc6b26d" width="40%" alt="UI Preview" />
  <br><br>
  <img src="https://github.com/user-attachments/assets/6f7beaad-2f92-48bc-a8ef-776a0886a8eb" width="40%" alt="UI Preview" />
  <br><br>
  <img src="https://github.com/user-attachments/assets/998e8a9e-ae27-4911-9e59-aef28245f60c" width="100%" alt="Example 1" />
  <br><br>
  <img src="https://github.com/user-attachments/assets/205a97d9-718d-4599-8511-ccf63e30691f" width="100%" alt="Example 2" />
  <br><br>
  <img src="https://github.com/user-attachments/assets/92427293-8ec7-40c3-b797-a2b27fedb8a6" width="100%" alt="Example 3" />
</p>
