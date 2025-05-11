import uuid, threading, time, re, logging, base64, tempfile, os, queue, httpx

base_temp = tempfile.gettempdir()
os.chdir(base_temp)

from PIL import Image
from io import BytesIO
from flask import Flask, request, jsonify
from flask_cors import CORS
from seleniumbase import Driver
from selenium.webdriver.common.by import By

log_queue = queue.Queue()

class QueueHandler(logging.Handler):
    def __init__(self, log_queue):
        super().__init__()
        self.log_queue = log_queue
    def emit(self, record):
        msg = self.format(record)
        self.log_queue.put(msg)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger()
logger.setLevel(logging.INFO)
queue_handler = QueueHandler(log_queue)
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
queue_handler.setFormatter(formatter)
logger.addHandler(queue_handler)

app = Flask(__name__)
CORS(app)

driver_lock = threading.Lock()
prev_mode = None
prev_lang = None
global_driver = None
global_first_image = True 
cached_cookies_dict = None
jobs = {}
task_queue = queue.Queue()
last_request_time = time.time()

def init_driver():
    global global_driver, global_first_image, prev_mode, prev_lang
    global_driver = Driver(uc=True, headless=True)
    if prev_mode == "lens":
        global_driver.get("https://lens.google.com/")
    elif prev_mode == "google_images":
        global_driver.get(f"https://translate.google.com/?sl=auto&tl={prev_lang}&op=images")
    global_first_image = True

def drag_and_drop_image(sb_driver, base64_image):
    try:
        drop_area_selector = "div.f6GA0"
        sb_driver.wait_for_element_visible(drop_area_selector, timeout=5)
        sb_driver.execute_script("""
            var dropArea = document.querySelector(arguments[0]);
            var base64Image = arguments[1];
            var byteCharacters = atob(base64Image);
            var byteNumbers = new Array(byteCharacters.length);
            for (var i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            var byteArray = new Uint8Array(byteNumbers);
            var file = new File([byteArray], 'file.jpg', { type: 'image/jpeg' });
            var dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            const dragEnterEvent = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dataTransfer });
            const dragOverEvent = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dataTransfer });
            const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dataTransfer });
            dropArea.dispatchEvent(dragEnterEvent);
            dropArea.dispatchEvent(dragOverEvent);
            dropArea.dispatchEvent(dropEvent);
        """, drop_area_selector, base64_image)
    except Exception as e:
        logging.error(f"❌ เกิดข้อผิดพลาดขณะอัปโหลดไฟล์: {e}")

def parse_calc_value(calc_str, dimension):
    m = re.search(r'calc\(([\d.]+)%\s*([+-])\s*([\d.]+)px\)', calc_str)
    if m:
        percentage = float(m.group(1))
        op = m.group(2)
        offset = float(m.group(3))
        if op == '-':
            return dimension * (percentage / 100.0) - offset
        else:
            return dimension * (percentage / 100.0) + offset
    else:
        return 0

def extract_boxes_and_text(sb_driver, include_without_line_index=False):
    logging.info("🔄 ดึงข้อมูล OCR (ข้อความและตำแหน่ง)")

    try:
        sb_driver.wait_for_element_visible("div.lv6PAb", timeout=5)
    except Exception:
        logging.info("⚠️ ไม่พบ div.lv6PAb ในเวลาที่กำหนด คืนค่าเป็นค่าว่าง")
        return []
    
    elements = sb_driver.find_elements("xpath", "//div[contains(@class, 'lv6PAb') and @aria-label]")
    results = []
    for elem in elements:
        data_line_index = elem.get_attribute("data-line-index")
        if not include_without_line_index and (data_line_index is None or data_line_index == ""):
            continue
        
        text = elem.get_attribute("aria-label")
        style = elem.get_attribute("style")
        if not text.strip() or not style:
            continue
        
        style_parts = [s.strip() for s in style.split(";") if s.strip()]
        style_dict = {}
        for part in style_parts:
            if ':' in part:
                key, value = part.split(":", 1)
                style_dict[key.strip()] = value.strip()
        top_str = style_dict.get("top")
        left_str = style_dict.get("left")
        width_str = style_dict.get("width")
        height_str = style_dict.get("height")
        
        if top_str and left_str and width_str and height_str:
            results.append({
                "text": text,
                "top_str": top_str,
                "left_str": left_str,
                "width_str": width_str,
                "height_str": height_str,
                "raw_style": style
            })
    return results

def merge_annotations_by_center_line(annotations, margin_x=10, margin_y=15):
    n = len(annotations)
    
    for ann in annotations:
        vertices = ann.get("boundingPoly", {}).get("vertices", [])
        if not vertices or len(vertices) != 4:
            continue
        xs = [v.get("x", 0) for v in vertices]
        ys = [v.get("y", 0) for v in vertices]
        ann["__left"] = min(xs)
        ann["__right"] = max(xs)
        ann["__top"] = min(ys)
        ann["__bottom"] = max(ys)
        ann["__center_x"] = (ann["__left"] + ann["__right"]) / 2.0
        ann["__center_y"] = (ann["__top"] + ann["__bottom"]) / 2.0

    parent = list(range(n))
    def find(i):
        if parent[i] != i:
            parent[i] = find(parent[i])
        return parent[i]
    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    for i in range(n):
        ann_i = annotations[i]
        cx_i = ann_i["__center_x"]
        ext_left_i = cx_i - margin_x
        ext_right_i = cx_i + margin_x
        ext_top_i = ann_i["__top"] - margin_y
        ext_bottom_i = ann_i["__bottom"] + margin_y
        for j in range(i + 1, n):
            ann_j = annotations[j]
            cond_x = (ext_left_i <= ann_j["__right"]) and (ext_right_i >= ann_j["__left"])
            cond_y = (ext_top_i <= ann_j["__bottom"]) and (ext_bottom_i >= ann_j["__top"])
            if cond_x and cond_y:
                union(i, j)

    groups = {}
    for i in range(n):
        root = find(i)
        groups.setdefault(root, []).append(annotations[i])

    merged_results = []
    for group in groups.values():
        if len(group) == 1:
            ann = group[0]
            bbox = ann.get("boundingPoly", {}).get("vertices", [])
            if bbox and len(bbox) == 4:
                left = bbox[0]["x"]
                top = bbox[0]["y"]
                right = bbox[1]["x"]
                bottom = bbox[2]["y"]
                width = right - left
                height = bottom - top
                single_style = f"top: {top}px; left: {left}px; width: {width}px; height: {height}px; transform: rotate({ann.get('rotate', 0)}deg);"
            else:
                single_style = ann.get("style", "")
            merged_results.append({
                "description": ann["description"],
                "boundingPoly": ann.get("boundingPoly"),
                "rotate": ann.get("rotate", 0),
                "style": single_style
            })
        else:
            merged_text = "\n".join([g["description"] for g in group])
            new_left = min(g["__left"] for g in group)
            new_right = max(g["__right"] for g in group)
            new_top = min(g["__top"] for g in group)
            new_bottom = max(g["__bottom"] for g in group)
            merged_boundingPoly = {
                "vertices": [
                    {"x": new_left, "y": new_top},
                    {"x": new_right, "y": new_top},
                    {"x": new_right, "y": new_bottom},
                    {"x": new_left, "y": new_bottom}
                ]
            }
            width = new_right - new_left
            height = new_bottom - new_top
            merged_style = f"top: {new_top}px; left: {new_left}px; width: {width}px; height: {height}px; transform: rotate(0deg);"
            merged_results.append({
                "description": merged_text,
                "boundingPoly": merged_boundingPoly,
                "rotate": 0,
                "style": merged_style
            })
    return merged_results

def process_ocr_lens(sb_driver, image_width, image_height, image_bytes=None):
    global cached_cookies_dict
    if image_bytes is None:
        raise Exception("image_bytes จำเป็นสำหรับ lens mode")
    if cached_cookies_dict is None:
        cached_cookies_dict = {
            cookie["name"]: cookie["value"]
            for cookie in sb_driver.get_cookies()
        }
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        "Referer": "https://lens.google.com/"
    }
    with httpx.Client(cookies=cached_cookies_dict, headers=headers, follow_redirects=False) as client:
        files = {"encoded_image": ("file.jpg", image_bytes, "image/jpeg")}
        response = client.post("https://lens.google.com/v3/upload", files=files)
        if response.status_code not in (303, 302):
            cached_cookies_dict = None
            raise Exception(f"❌ Unexpected status code: {response.status_code}")
        redirect_url = response.headers.get("location")
    sb_driver.get(redirect_url)
    sb_driver.wait_for_element_visible("div.lv6PAb", timeout=5)
    boxes = extract_boxes_and_text(sb_driver, include_without_line_index=False)
    text_annotations = []
    full_text = ""
    for box in boxes:
        abs_top = parse_calc_value(box["top_str"], image_height)
        abs_left = parse_calc_value(box["left_str"], image_width)
        abs_width = parse_calc_value(box["width_str"], image_width)
        abs_height = parse_calc_value(box["height_str"], image_height)
        vertices = [
            {"x": int(abs_left), "y": int(abs_top)},
            {"x": int(abs_left + abs_width), "y": int(abs_top)},
            {"x": int(abs_left + abs_width), "y": int(abs_top + abs_height)},
            {"x": int(abs_left), "y": int(abs_top + abs_height)}
        ]
        rotate = 0.0
        m_rotate = re.search(r'rotate\(([-\d.]+)deg\)', box["raw_style"])
        if m_rotate:
            rotate = float(m_rotate.group(1))
        text_annotations.append({
            "description": box["text"],
            "boundingPoly": {"vertices": vertices},
            "rotate": rotate,
            "style": box["raw_style"]
        })
        full_text += box["text"] + " "
    merged_annotations = merge_annotations_by_center_line(text_annotations)
    result = {
        "textAnnotations": merged_annotations,
        "rawTextAnnotations": text_annotations,
        "fullTextAnnotation": {"text": full_text.strip()}
    }
    return result

# ocr translate   
def drag_and_drop_file(sb_driver, file_input_selector, base64_image):
    try:
        sb_driver.execute_script("""
            var fileInput = document.querySelector(arguments[0]);
            var base64Image = arguments[1];
            var byteCharacters = atob(base64Image);
            var byteNumbers = new Array(byteCharacters.length);
            for (var i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            var byteArray = new Uint8Array(byteNumbers);
            var file = new File([byteArray], 'file.jpg', { type: 'image/jpeg' });
            var dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            fileInput.files = dataTransfer.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        """, file_input_selector, base64_image)
        logging.info("Translator: Simulated drag and drop of the image")
    except Exception as e:
        logging.error(f"Translator: Error during drag and drop: {e}")
        
def clear_image(sb_driver):
    try:
        clear_button_selector = 'button.VfPpkd-Bz112c-LgbsSe.yHy1rc.eT1oJ.mN1ivc.B0czFe'
        sb_driver.find_element(By.CSS_SELECTOR, clear_button_selector)
        sb_driver.execute_script(f"document.querySelector('{clear_button_selector}').click();")
    except Exception as e:
        logging.error(f"Translator: Error clearing image: {e}")

def download_blob_image(driver_translate, blob_url):
    try:
        return driver_translate.execute_async_script("""
            var url = arguments[0], callback = arguments[arguments.length - 1];
            fetch(url).then(response => response.blob())
                .then(blob => {
                    const reader = new FileReader();
                    reader.onloadend = function () {
                        const base64 = reader.result.split(',')[1];
                        callback(base64);
                    };
                    reader.onerror = function () {
                        callback(null);
                    };
                    reader.readAsDataURL(blob);
                }).catch(() => callback(null));
        """, blob_url)
    except Exception as e:
        logging.error(f"Translator: Error downloading Blob image from {blob_url}: {e}")
        return None
        
def process_ocr_translate(sb_driver, image_bytes=None, base64_image=None):
    b64: str
    if base64_image is not None:
        b64 = base64_image
        if isinstance(b64, (bytes, bytearray)):
            try:
                b64 = b64.decode('utf-8')
            except Exception:
                logging.error(f"Translator: Cannot decode base64_image bytes")
                return None
    elif image_bytes:
        try:
            b64 = base64.b64encode(image_bytes).decode('utf-8')
        except Exception as e:
            logging.error(f"Translator: Failed to encode image_bytes → base64: {e}")
            return None
    else:
        logging.error("Translator: No image data provided to process_ocr_translate")
        return None

    try:
        logging.debug(f"Translator: Uploading image (type={type(b64)})")
        drag_and_drop_file(
            sb_driver,
            'input[type="file"][accept="image/jpeg, image/png, image/webp, .jpeg, .jpg, .png, .webp"]',
            b64
        )
    except Exception as e:
        logging.error(f"Translator: Error during drag and drop: {e}")
        clear_image(sb_driver)
        return None

    try:
        sb_driver.wait_for_element_visible(".CMhTbb.tyW0pd img", timeout=10)
        translated_img = sb_driver.find_element(By.CSS_SELECTOR, ".CMhTbb.tyW0pd img")
        blob_url = translated_img.get_attribute("src")
        logging.info(f"Translator: Retrieved blob URL → {blob_url}")
    except Exception as e:
        logging.error(f"Translator: Translated image not found: {e}")
        clear_image(sb_driver)
        return None

    try:
        base64_translated = download_blob_image(sb_driver, blob_url)
        if not base64_translated:
            raise RuntimeError("Empty base64 from blob")
        result_data_url = f"data:image/jpeg;base64,{base64_translated}"
        logging.info("Translator: Translation succeeded")
        return result_data_url
    except Exception as e:
        logging.error(f"Translator: Error downloading translated blob: {e}")
        return None
    finally:
        try:
            clear_image(sb_driver)
        except:
            pass

def monitor_driver():
    global last_request_time, global_driver, global_first_image, cached_cookies_dict
    while True:
        time.sleep(5)
        if global_driver is not None and time.time() - last_request_time > 60:
            logging.info("ไม่มีงานเป็นเวลา 60 วินาที ปิดเบราว์เซอร์...")
            try:
                global_driver.quit()
            except Exception as e:
                logging.error("Error quitting driver: " + str(e))
            global_driver = None
            cached_cookies_dict = None
            global_first_image = True

def ocr_worker():
    global jobs, global_driver, global_first_image, last_request_time, cached_cookies_dict, prev_mode, prev_lang
    while True:
        task = task_queue.get()
        job_id = task["job_id"]
        mode = task['mode']
        lang = task['language']
        image_bytes = task["image_bytes"]
        image_width = task["image_width"]
        image_height = task["image_height"]
        base64_image = task.get("base64_image")
        prev_mode, prev_lang = mode, lang
        try:
            with driver_lock:
                last_request_time = time.time()
                if global_driver is None:
                    logging.info("เปิดเบราว์เซอร์ใหม่...")
                    init_driver()
                sb_driver = global_driver
                if prev_mode == "lens":
                    result = process_ocr_lens(sb_driver, image_width, image_height, image_bytes)
                elif prev_mode == "google_images":
                    result = process_ocr_translate(sb_driver, image_bytes, base64_image)
                    
                if global_first_image:
                    global_first_image = False
            jobs[job_id] = {"status": "done", "result": result}
        except Exception as e:
            cached_cookies_dict = None
            logging.error(f"❌ Error processing job {job_id}: {e}")
            jobs[job_id] = {"status": "error", "error": str(e)}
        finally:
            task_queue.task_done()

threading.Thread(target=ocr_worker, daemon=True).start()
threading.Thread(target=monitor_driver, daemon=True).start()

@app.route('/ocr', methods=['POST'])
def ocr_endpoint():
    global last_request_time
    last_request_time = time.time()
    if 'image' not in request.files:
        return jsonify({"error": "ไม่มีไฟล์ image ใน request"}), 400
    mode = request.form.get("mode", "google_images")
    language = request.form.get('language', 'th')
    image_file = request.files['image']
    image_bytes = image_file.read()
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image_width, image_height = image.size
            image.load()
        base64_image = base64.b64encode(image_bytes).decode('utf-8')
        job_id = str(uuid.uuid4())
        jobs[job_id] = {"status": "processing"}
        
        task = {
            "job_id": job_id,
            "mode": mode,
            "language": language,
            "image_bytes": image_bytes,
            "image_width": image_width,
            "image_height": image_height,
            "base64_image": base64_image 
        }
        task_queue.put(task)
        return jsonify({"job_id": job_id, "status": "processing"})
    except Exception as e:
        logging.error(f"❌ Error during OCR submission: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/ocr/result/<job_id>', methods=['GET'])
def get_result(job_id):
    if job_id in jobs:
        return jsonify(jobs[job_id])
    else:
        return jsonify({"status": "pending"}), 202

@app.route('/shutdown', methods=['POST'])
def shutdown():
    shutdown_server = request.environ.get('werkzeug.server.shutdown')
    if shutdown_server is None:
        logging.error("Server shutdown function not available.")
        return jsonify({"error": "Server shutdown not available in production."}), 500
    shutdown_server()
    return jsonify({"message": "Server shutting down..."}), 200

if __name__ == '__main__':
    from waitress import serve
    serve(app, host='0.0.0.0', port=5000)
