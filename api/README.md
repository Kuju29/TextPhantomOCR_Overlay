---
title: TextPhantom v4.0.0
emoji: 👻
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
---

TextPhantom OCR Overlay API

runs: Extension

```mermaid
flowchart TD

subgraph EXT["ส่วนขยาย"]
    A["อ่านภาพ / Capture"]
    S["Service Worker Scheduler<br/>เลนแยกต่อ provider+model+key"]
    ENG{"Where the work runs"}
    SRC{"เลือกโหมด / Source"}

    D["Decode Lens Response"]
    E["สร้าง LensDocument"]
    AX{"ตรวจแกนข้อความ"}
    ATT["แนบ semanticGroups"]
    SRC2{"Source"}

    O1["Original Visual Tree"]
    T1{"Rotate Translated?"}
    AI1["สร้าง Translation Units"]
    AI2["Map คำตอบ AI กลับ LensDocument"]

    FID{"วาดในเบราว์เซอร์ได้ไหม"}
    STOP["หยุด + engineRoute outcome=stopped<br/>พร้อมเหตุผลจริง"]

    R["ตรวจสี + Erase Geometry"]
    H["สร้าง HTML Overlay"]
    I["แทรก Overlay ลงหน้าเว็บ"]
    SRVHTML["แทรก markup ของเซิร์ฟเวอร์<br/>reportRoute('server')"]
    IMG["REPLACE_IMAGE"]
end

subgraph API["API"]
    V1["POST /v1/translate"]
    PIPE["pipeline.py<br/>Lens + ONNX + AI + erase + fonts + HTML"]
    LR["POST /v1/lens/raw"]
    GP["POST /v1/groups"]
    ONNX["ONNX ตรวจกลุ่มข้อความ"]
    AIT["POST /v1/ai/translate<br/>+ rate gate ต่อ key"]
end

subgraph LENS["Google Lens"]
    GL1["OCR + Lens Translation"]
    GL2["Lens Translated Image"]
end

subgraph MODEL["AI Provider"]
    P["Gemini / HF / Local / Provider อื่น"]
end

A --> S
S --> SRC
SRC -->|"Google Lens image"| V1
V1 --> GL2
GL2 --> V1
V1 --> IMG

SRC -->|"Text"| ENG
ENG -->|"API server"| V1
V1 --> PIPE
PIPE --> SRVHTML

ENG -->|"Extension"| LR
LR --> GL1
GL1 --> LR
LR --> D
D --> E
E --> AX

AX -->|"แนวนอน"| SRC2
AX -->|"แนวตั้ง"| GP
GP --> ONNX
ONNX --> GP
GP --> ATT
ATT --> SRC2

SRC2 -->|"Original"| O1
SRC2 -->|"Translated"| T1
SRC2 -->|"AI"| AI1
AI1 --> AIT
AIT --> P
P --> AIT
AIT --> AI2

O1 --> FID
T1 --> FID
AI2 --> FID
FID -->|"ไม่ได้"| STOP
FID -->|"ได้"| R
R --> H
H --> I
```

runs: API server

```mermaid
flowchart TD

subgraph EXT["ส่วนขยาย"]
    A["อ่านภาพ"]
    PAY["payload: render.background=image<br/>render.lensDocument=false<br/>engine=api"]
    INS["sanitise แล้วแทรก markup ของเซิร์ฟเวอร์<br/>reportRoute('server')"]
end

subgraph API["API — pipeline.py คำขอเดียวจบ"]
    V1["POST /v1/translate"]
    L["fetch_lens_data() อัปโหลด Lens"]
    TREE["decode_tree() original + translated"]
    DEC{"ต้องใช้ ONNX ไหม"}
    ON["textblocks_pass.detect_blocks_with_second_look()<br/>โมดูลเดียวกับที่ /v1/groups ใช้<br/>รอบแรก → มุมมองที่สอง → กู้คอลัมน์"]
    AICALL["เรียกผู้ให้บริการ AI ผ่าน rate gate<br/>เฉพาะ source=ai"]
    ER["erase_text_with_boxes()"]
    RESTORE["restore_token_regions():<br/>คืนพิกเซลของ unit ที่ AI ไม่ตอบ<br/>แล้ว encode ใหม่"]
    FIT["fit_tree_font_sizes()"]
    RENDER["render_tree_overlay() → originalhtml / translatedhtml / aihtml"]
    PNG["เข้ารหัสภาพพื้นหลังเป็น data URI"]
end

subgraph LENS["Google Lens"]
    C["OCR + Lens Translation"]
end

A --> PAY
PAY --> V1
V1 --> L
L --> C
C --> L
L --> TREE
TREE --> DEC
DEC -->|"ใช่"| ON
DEC -->|"ไม่"| AICALL
ON --> AICALL
AICALL --> ER
ER --> FIT
FIT --> RENDER
RENDER --> PNG
PNG --> RESTORE
RESTORE --> INS
```
## API patch 2026.8.20.10

- Adds a conservative Lens-geometry fallback for vertical pages when ONNX returns no usable paragraph stamps.
- ONNX remains the primary grouping authority. The fallback runs only on zero-hit pages and only succeeds when every vertical paragraph relation is either strongly same-unit or provably separate.
- Any ambiguous pair keeps the existing explicit grouping failure; the API does not guess and does not translate possible sentence fragments.
- Sparse pages with one short vertical utterance per bubble can now continue without a false `ONNX: text grouping failed`.
- Strongly aligned multi-column utterances can still be reconstructed into one synthetic block.
- A strong ink wall between close columns vetoes a geometry merge.
- The same fallback is used by both `runs:Extension` (`/v1/groups`) and `runs:API server` (`pipeline.py`). No browser-extension change is required.
- Trace output now includes `geometryFallback` metadata and the API-server performance stages expose geometry-fallback counts.
- Runtime toggle: `TP_TEXTBLOCK_GEOMETRY_FALLBACK=1` (default on). `TP_TEXTBLOCK_GEOMETRY_FALLBACK_MAX_PARAGRAPHS=48` bounds the fallback's pairwise geometry check.
- This patch has no dependency on Hugging Face Dev Mode. Dev Mode may be disabled after trace/validation; normal production startup is unchanged.
