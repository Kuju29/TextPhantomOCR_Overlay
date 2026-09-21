<p align="right">
  <a href="./README.md">English</a> · <strong>ไทย</strong>
</p>

# ✨ TextPhantomOCR Overlay 
![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FKuju29%2FTextPhantomOCR_Overlay%2Fmain%2Fplatform%2Fbase.json&query=%24.version&label=Version&color=blue)
[![Website](https://img.shields.io/badge/Website-kuju29.github.io-blue?style=flat-square&logo=github&logoColor=white)](https://kuju29.github.io/)
[![Video Guide](https://img.shields.io/badge/Video_Guide-YouTube-red?style=flat-square&logo=youtube&logoColor=white)](https://youtu.be/5GuW_qyg1GU)

### หมายเหตุ

- โมเดลที่ใช้ทดสอบกับ **text.AI**:
  - Hugging Face — `deepseek-ai/DeepSeek-V4-Pro` — ฟรี (ใช้เยอะต้องเติมเครดิตเข้าไว้)
  - OpenRouter — `deepseek/deepseek-v4-flash-0731` — มีค่าใช้จ่าย
  - Google Gemini — `gemini-2.5-flash` — ใช้เยอะอาจมีค่าใช้จ่าย
  - Ollama — `qwen3.5:9b` — ฟรี

![TextPhantom Demo](https://github.com/user-attachments/assets/43cc9a1e-eb79-46f0-b4a1-08ca9bcd49f5)

---

## 📥 1. ติดตั้งส่วนขยาย

| Browser | สถานะ | ติดตั้ง |
| :--- | :---: | :--- |
| <img src="https://cdn.simpleicons.org/googlechrome" width="20" height="20"> **Chrome** | ✅ พร้อมใช้งาน | **[Chrome Web Store](https://chromewebstore.google.com/detail/cjbaepobgmickhgebgagklfcfacbbpem)** |
| <img src="https://cdn.simpleicons.org/brave" width="20" height="20"> **Brave** | ✅ พร้อมใช้งาน | **[Chrome Web Store](https://chromewebstore.google.com/detail/cjbaepobgmickhgebgagklfcfacbbpem)** |
| <img src="https://cdn.simpleicons.org/firefoxbrowser" width="20" height="20"> **Firefox** | ✅ พร้อมใช้งาน | **[Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/textphantom-%E0%B9%81%E0%B8%9B%E0%B8%A5%E0%B8%82%E0%B8%AD%E0%B8%84%E0%B8%A7%E0%B8%B2%E0%B8%A1%E0%B9%83%E0%B8%99%E0%B8%A0%E0%B8%B2%E0%B8%9E%E0%B8%A1%E0%B8%87%E0%B8%87%E0%B8%B0/)** |
| <img src="https://r.bing.com/rp/LsvpbzBUOsWWr-fV50e3ltHS3IE.png" width="20" height="20"> **Edge** | ⏳ รออนุมัติ | เร็ว ๆ นี้ |
| <img src="https://cdn.simpleicons.org/opera" width="20" height="20"> **Opera** | ⏳ รออนุมัติ | เร็ว ๆ นี้ |

> **Brave:** สามารถติดตั้งเวอร์ชัน Chrome จาก Chrome Web Store ได้โดยตรง

<details>
<summary><strong>🛠️ การติดตั้งด้วยตนเองและเวอร์ชันเก่า</strong></summary>

<br>

### 1.1 ติดตั้งด้วยตนเอง

| เวอร์ชัน | Extension | API | |
| :--- | :--- | :--- | :--- |
| **Latest (`main`)** | [![Extension](https://img.shields.io/badge/Extension-Download_Latest-yellow?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/archive/refs/heads/main.zip) | [![API](https://img.shields.io/badge/API-Hugging_Face-blue?logo=huggingface)](https://huggingface.co/spaces/plan291037/TextPhantom-v4.0.0/tree/main) | **ล่าสุด** |
| **[v4.0.1](https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/v4.0.1)** | [![Extension](https://img.shields.io/badge/Extension-v4.0.1-yellow?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/archive/refs/tags/v4.0.1.zip) | [![API](https://img.shields.io/badge/API-Hugging_Face-blue?logo=huggingface)](https://huggingface.co/spaces/plan291037/TextPhantom-v4.0.0/tree/main) | เวอร์ชันก่อนหน้า |
| **[v3.0.1](https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/v3.0.1)** | [![Extension](https://img.shields.io/badge/Extension-v3.0.1-yellow?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/archive/refs/tags/v3.0.1.zip) | [![API](https://img.shields.io/badge/API-Hugging_Face-blue?logo=huggingface)](https://huggingface.co/spaces/plan291037/TextPhantom_OCR_API2/tree/main) | เวอร์ชันก่อนหน้า |
| **[v2.0.2](https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/backup_V2.0.2)** | [![Extension](https://img.shields.io/badge/Extension-v2.0.2-yellow?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/archive/refs/tags/backup_V2.0.2.zip) | [![API](https://img.shields.io/badge/API-GitHub-blue?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/releases/tag/v2.0.2) | Legacy |
| **[v1.0.1](https://github.com/Kuju29/TextPhantomOCR_Overlay/tree/v1.0.1)** | [![Extension](https://img.shields.io/badge/Extension-v1.0.1-yellow?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/archive/refs/tags/v1.0.1.zip) | [![API](https://img.shields.io/badge/API-GitHub-blue?logo=github)](https://github.com/Kuju29/TextPhantomOCR_Overlay/releases/tag/v1.0.1) | Legacy |

> **Latest (`main`)** คือซอร์สโค้ดล่าสุดจาก repository และอาจใหม่กว่าเวอร์ชันที่เผยแพร่บน Browser Store

### 1.2 วิธีติดตั้ง Latest (`main`)

1. ดาวน์โหลดและแตกไฟล์ **Latest (`main`)**
2. ดับเบิลคลิก `build.bat`
3. เมื่อ Build เสร็จ จะสร้าง:
   - `dist/` — โฟลเดอร์ส่วนขยายที่พร้อมนำไปติดตั้ง
   - `packages/` — ไฟล์ ZIP สำหรับแต่ละ Browser
4. เปิดหน้าจัดการส่วนขยาย เช่น Chrome → `chrome://extensions/`
5. เปิด **Developer Mode**
6. กด **Load unpacked**
7. เลือกโฟลเดอร์ของ Browser ที่ต้องการจาก `dist/`

### 1.3 Hugging Face API

#### Public API

1. ติดตั้งและเปิด **TextPhantom**
2. กด **Refresh API URL**
3. เริ่มแปลได้เลย 🎉

> Public API ใช้งานร่วมกับผู้ใช้อื่น จึงอาจช้าลงในช่วงที่มีผู้ใช้งานจำนวนมาก

#### API ของคุณเอง

1. เปิด [TextPhantom Hugging Face Space](https://huggingface.co/spaces/plan291037/TextPhantom-v4.0.0/tree/main)
2. กด **⋯ → Duplicate this Space**
3. รอจนสถานะเป็น **Running**
4. กด **⋯ → Embed this Space** แล้วคัดลอก URL
5. นำ URL ไปใส่ใน **Custom API URL**

> Hugging Face Space แบบฟรีอาจหยุดทำงานอัตโนมัติเมื่อไม่มีการใช้งานเป็นระยะเวลาหนึ่ง

</details>

---

## 🎉 2. เริ่มใช้งาน

| สิ่งที่คุณทำ | TextPhantom จะแสดง |
| :--- | :--- |
| 🖼️ **คลิกขวาที่ภาพ** | 🔍 Translates only that image |
| 📚 **คลิกขวาที่พื้นที่ว่างของหน้าเว็บ** | 🔍 Translates all images on the page |
| 🚧 **`Translate tab` → Page actions** | สำหรับเว็บไหนไม่รองรับการคลิกขวาต้องไปเรียกใช้ฟังชั่นนี้ใน UI |

### 🎨 เลือกรูปแบบการแปล

เปิด `Translate tab` แล้วเลือก **Mode**

| Mode | วิธีทำงาน | ผลลัพธ์ |
| :--- | :--- | :--- |
| **Image** | ภาพต้นฉบับ → **Google Translate** → ภาพแปล | แทนที่ภาพต้นฉบับด้วยภาพที่แปลจาก Google Translate |
| **Text** | ภาพต้นฉบับ → **ตรวจจับข้อความ** → วางข้อความทับบนภาพ | แทรกภาพที่ลบข้อความแล้ว และแทรก **ข้อความทับบนภาพ** โดยสามารถเลือกแหล่งคำแปลได้จาก **Source** |

#### 💬 Mode Text → Source

เมื่อใช้ **Text Mode** จะมีตัวเลือก **Source** ให้เลือก:

| Source | วิธีแปล | การทำงาน |
| :--- | :--- | :--- |
| 🌐 **Original** | **แทรกข้อความต้นฉบับบนภาพ** | แสดงข้อความภาษาต้นฉบับบนภาพ ผู้ใช้สามารถใช้การคลิกขวา **Translate to...** ของ Browser อีกครั้งเพื่อแปลข้อความบนภาพได้ครับ จะดีกว่าของ image นิดหน่อย ที่สำคัญฟรี |
| 🔤 **Translated** | **แทรกข้อความเดียวกับโหมด image บนภาพ** | ดึงข้อความของโหมด image มาแสดงแบบเป็นข้อความทับบนภาพ |
| 🤖 **AI** | **ส่งข้อความให้ Ai แปล** | ส่งข้อความที่ตรวจจับได้ให้โมเดล AI ที่คุณเลือกเพื่อแปล แปลดีในบางครั้งเพราะ Ai จำได้เฉพาะหน้านั้นๆครับ |
> [!TIP]
> 💡 **ทางเลือกฟรี:** ใช้ **Text → Original** จากนั้นคลิกขวาที่พื้นที่ว่างของหน้าเว็บ แล้วเลือก **Translate to...** ของ Browser อีกครั้งเพื่อแปลข้อความบนภาพ

### 🤖 การแปลด้วย AI

หากเลือก **Text → AI** ให้เปิด `AI option` และตั้งค่าตามลำดับ:

| ขั้นตอน | การตั้งค่า | สิ่งที่ต้องทำ |
| :---: | :--- | :--- |
| **1** | **Provider** | เลือกผู้ให้บริการ AI |
| **2** | **API key** | ใส่ API Key ของ Provider |
| **3** | **Model** | เลือกโมเดล AI ที่ต้องการใช้ |
| **4** | **Set prompt** | ตั้งค่าคำสั่งสำหรับการแปล |

> [!WARNING] 
>  **Set prompt** จำเป็นต้องกด **↺ Reset** เพื่อโหลด Prompt พื้นฐานจาก TextPhantom API ก่อนใช้งาน

<details>
<summary><strong>ตัวเลือก AI เพิ่มเติม</strong></summary>

<br>

| ตัวเลือก | การทำงาน |
| :--- | :--- |
| 🧠 **Series memory** | จดจำชื่อตัวละคร คำศัพท์ และบริบทของเรื่อง เพื่อให้การแปลต่อเนื่อง |
| 👁️ **Page image to AI** | ส่งภาพให้โมเดล AI ที่รองรับ เพื่อใช้ภาพประกอบการทำความเข้าใจบริบท |
| 🚦 **Manual AI request-rate cap** | จำกัดจำนวนคำขอ AI ที่ส่งได้ต่อนาที |

</details>

### 🧰 Tools

ต้องการแปลภาพที่อยู่ในเครื่อง? เปิด `Tools tab`

| Tool | การทำงาน |
| :--- | :--- |
| 🖼️ **Select an image** | เปิดภาพในเครื่อง แล้วคลิกขวาเพื่อแปล |
| 📁 **Select folder** | เปิดโฟลเดอร์ภาพในเครื่อง |
| ⚡ **Auto translate** | วาง Paste, ลาก Drop หรือ Upload ภาพเพื่อเริ่มแปลอัตโนมัติ |
| ↺ **Reset** | คืนค่าการตั้งค่าในส่วนนั้นกลับเป็นค่าเริ่มต้น |

---

## 🆓 ตัวเลือก AI ฟรี

กำลังมองหา AI ฟรีสำหรับใช้แปลกับ **TextPhantom**?

คุณสามารถรัน AI บนเครื่องตัวเองด้วย **Ollama** หรือใช้ **Hugging Face** บน Cloud

| ตัวเลือก | ทำงานที่ไหน | API Key | เหมาะสำหรับ |
| :--- | :--- | :---: | :--- |
| 🖥️ **Ollama** | เครื่องของคุณ | ❌ ไม่ต้องใช้ | ผู้ที่ต้องการ **Local AI ฟรี** และเครื่องมีทรัพยากรเพียงพอ |
| ☁️ **Hugging Face** | Cloud | ✅ ต้องใช้ | ผู้ที่ไม่ต้องการรันโมเดล AI บนเครื่องตัวเอง |

### 🖥️ ตัวเลือก 1 — Ollama (Local AI)

รันโมเดล AI บนเครื่องของคุณโดยตรง  
**ไม่ต้องใช้ AI API Key**

1. ติดตั้ง **Ollama**  
   https://ollama.com/download

2. อนุญาตให้ TextPhantom เชื่อมต่อกับ Ollama

   เปิด PowerShell แล้วรัน:

   ```powershell
   $env:OLLAMA_ORIGINS="chrome-extension://*"
   ```

3. ติดตั้งโมเดล AI เช่น:

   ```powershell
   ollama pull gemma3
   ```

4. เปิด **TextPhantom → AI option → Provider → Local AI (Ollama)**
5. กด **Connect** แล้วเลือกโมเดลที่ติดตั้งไว้
6. กลับไปที่ **Translate → Text → Source: AI** แล้วเริ่มแปล 🎉
> [!NOTE]
> **Ollama ต้องเปิดทำงานอยู่** ระหว่างใช้งาน Local AI

### ☁️ ตัวเลือก 2 — Hugging Face (Cloud AI)

รันโมเดล AI บน Cloud โดยไม่ต้องติดตั้งโมเดลลงในเครื่อง  
**ไม่จำเป็นต้องมี GPU แรง**

1. [สร้างบัญชีหรือเข้าสู่ระบบ Hugging Face](https://huggingface.co/login)

2. เปิด [Google Gemma 3](https://huggingface.co/google/gemma-3-27b-it)  
   แล้วกด **Agree and access**

3. [สร้าง API Token](https://huggingface.co/settings/tokens)

4. เปิดสิทธิ์:

   - ✅ **Read access to contents of all public gated repos you can access**

5. คัดลอก Token แล้วใส่ใน **TextPhantom → AI option → Hugging Face API Key**

6. เลือก **Google Gemma**

7. กลับไปที่ **Translate → Text → Source: AI** แล้วเริ่มแปล 🎉
> [!NOTE]
> เหมาะสำหรับเครื่องที่ไม่สามารถรันโมเดล AI ในเครื่องได้สะดวก

---

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
