import uuid, threading, time, re, logging, base64, tempfile, os, subprocess, queue, requests, json5

temp_dir = tempfile.mkdtemp()
os.chdir(temp_dir)
subprocess.run(
    ["pytest", "--maxfail=1", "--disable-warnings", "-q"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL
)

from sklearn.cluster import DBSCAN
from flask import Flask, request, jsonify
from flask_cors import CORS
from seleniumbase import Driver
from PIL import Image
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor, TimeoutError

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
global_driver = None
global_first_image = True 
jobs = {}
last_request_time = time.time()

def init_driver():
    global global_driver, global_first_image
    global_driver = Driver(uc=True, headless=True)
    global_driver.get("https://lens.google.com/")
    global_driver.wait_for_element_visible("div.f6GA0", timeout=10)
    global_first_image = True

def convert_image_to_base64(image_bytes):
    return base64.b64encode(image_bytes).decode('utf-8')

def click_upload_button(sb_driver):
    try:
        collapse_button_selector = "button.XWrYL"
        sb_driver.wait_for_element_visible(collapse_button_selector, timeout=5)
        if sb_driver.is_element_visible(collapse_button_selector):
            sb_driver.click(collapse_button_selector)
        upload_button_selector = "div.nDcEnd"
        sb_driver.wait_for_element_visible(upload_button_selector, timeout=5)
        if sb_driver.is_element_visible(upload_button_selector):
            sb_driver.click(upload_button_selector)
            sb_driver.wait_for_element_visible("div.f6GA0", timeout=5)
            return True
        else:
            logging.warning("⚠️ ไม่พบปุ่ม 'Search by image' ต้องเปิด Google Lens ใหม่")
            return False
    except Exception as e:
        logging.error(f"❌ เกิดข้อผิดพลาดขณะกดปุ่ม 'Search by image': {e}")
        return False

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
    logging.info("🔄 ดึงข้อมูล OCR (ข้อความและตำแหน่ง) แบบเดิม...")
    try:
        sb_driver.wait_for_element_visible("div.lv6PAb", timeout=10)
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

def merge_annotations_by_center_line(annotations, margin_x=10, margin_y=10):
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

def process_ocr_sync(mode, sb_driver, image_width, image_height):
    if mode == "fast":
        metadata = extract_metadata_from_lens(sb_driver, retry=10, delay=0.2)
        if metadata is not None:
            raw_annotations = process_metadata_to_raw_annotations(metadata, image_width, image_height)
            horizontal_grouped = group_annotations_horizontally(raw_annotations)
            vertical_merged = merge_annotations_by_center_line(horizontal_grouped)
            full_text = " ".join([ann["description"] for ann in horizontal_grouped]).strip()
            result = {
                "textAnnotations": vertical_merged,
                "rawTextAnnotations": horizontal_grouped,
                "fullTextAnnotation": {"text": full_text}
            }
            return result
        logging.info("Fallback ใน fast mode: ใช้การรอผล OCR แบบ non-fast")
    
    try:
        sb_driver.wait_for_element_visible("div.lv6PAb", timeout=10)
    except Exception as e:
        raise Exception("ไม่พบผล OCR ในเวลาที่กำหนด")
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

def process_ocr_and_set_result(job_id, mode, sb_driver, image_width, image_height):
    try:
        result = process_ocr_sync(mode, sb_driver, image_width, image_height)
        jobs[job_id] = {"status": "done", "result": result}
    except Exception as e:
        jobs[job_id] = {"status": "error", "error": str(e)}

def monitor_driver():
    global last_request_time, global_driver, global_first_image
    while True:
        time.sleep(5)
        if global_driver is not None and time.time() - last_request_time > 60:
            logging.info("ไม่มีงานเป็นเวลา 60 วินาที ปิดเบราว์เซอร์...")
            try:
                global_driver.quit()
            except Exception as e:
                logging.error("Error quitting driver: " + str(e))
            global_driver = None
            global_first_image = True

threading.Thread(target=monitor_driver, daemon=True).start()

def safe_get_value(data, indices):
    try:
        for i in indices:
            data = data[i]
        return data
    except (IndexError, TypeError):
        return None

def extract_metadata_from_lens(sb_driver, retry=10, delay=0.2):
    try:
        for _ in range(retry):
            try:
                link_elem = sb_driver.find_element("css selector", "link[rel='preload'][href*='qfmetadata']")
                metadata_url = link_elem.get_attribute("href")
                if metadata_url:
                    break
            except:
                pass
            time.sleep(delay)
        else:
            logging.error("❌ ไม่พบ qfmetadata หลังจากพยายามหลายครั้ง")
            return None
        logging.info(f"🔗 ดึง URL ของ qfmetadata: {metadata_url}")
        cookies_dict = {cookie["name"]: cookie["value"] for cookie in sb_driver.get_cookies()}
        headers = {"User-Agent": sb_driver.execute_script("return navigator.userAgent;")}
        resp = requests.get(metadata_url, cookies=cookies_dict, headers=headers)
        resp.raise_for_status()
        text = resp.text
        if text.startswith(")]}'"):
            text = text.split("\n", 1)[1] if "\n" in text else text[4:]
        metadata = json5.loads(text)
        return metadata
    except Exception as e:
        logging.error(f"❌ extract_metadata_from_lens error: {e}")
        return None

def process_metadata_to_raw_annotations(metadata, image_width, image_height):
    resp = next((x for x in metadata if isinstance(x, list) and x and x[0] == "fetch_query_formulation_metadata_response"), None)
    if not resp:
        return []
    chains = [[1,0,0,0], [2,0,0,0], [1,0,0], [2,0,0]]
    segs = None
    for chain in chains:
        segs = safe_get_value(resp, chain)
        if segs and isinstance(segs, list) and segs and isinstance(segs[0], list) and len(segs[0]) > 1 and isinstance(segs[0][1], list):
            break
        else:
            segs = None
    annotations = []
    
    offset_x = 0.0 * image_width
    offset_y = 0.0 * image_height

    if segs:
        for seg in segs:
            if not (isinstance(seg, list) and len(seg) >= 2 and isinstance(seg[1], list)):
                continue
            for group in seg[1]:
                if not (isinstance(group, list) and group and isinstance(group[0], list)):
                    continue
                for word in group[0]:
                    if (isinstance(word, list) and len(word) > 3 and isinstance(word[1], str)
                        and isinstance(word[2], str) and isinstance(word[3], list) and word[3] and isinstance(word[3][0], list)):
                        text = word[1]
                        bbox = word[3][0]
                        if len(bbox) >= 4:
                            x_norm, y_norm, w_norm, h_norm = bbox[0], bbox[1], bbox[2], bbox[3]
                            
                            x_abs = int(x_norm * image_width - offset_x)
                            y_abs = int(y_norm * image_height - offset_y)
                            w_abs = int(w_norm * image_width)
                            h_abs = int(h_norm * image_height)
                            vertices = [
                                {"x": x_abs, "y": y_abs},
                                {"x": x_abs + w_abs, "y": y_abs},
                                {"x": x_abs + w_abs, "y": y_abs + h_abs},
                                {"x": x_abs, "y": y_abs + h_abs}
                            ]
                            style = f"top: {y_abs}px; left: {x_abs}px; width: {w_abs}px; height: {h_abs}px; transform: rotate(0deg);"
                            annotations.append({
                                "description": text,
                                "boundingPoly": {"vertices": vertices},
                                "rotate": 0,
                                "style": style
                            })
    return annotations

def group_annotations_horizontally(annotations, vertical_threshold=5, horizontal_gap_threshold=5):
    groups = []
    used = [False] * len(annotations)
    for i, ann in enumerate(annotations):
        if used[i]:
            continue
        group = [ann]
        used[i] = True
        v0 = ann["boundingPoly"]["vertices"][0]["y"]
        v2 = ann["boundingPoly"]["vertices"][2]["y"]
        center_y_i = (v0 + v2) / 2.0
        for j in range(i + 1, len(annotations)):
            if used[j]:
                continue
            ann_j = annotations[j]
            j_v0 = ann_j["boundingPoly"]["vertices"][0]["y"]
            j_v2 = ann_j["boundingPoly"]["vertices"][2]["y"]
            center_y_j = (j_v0 + j_v2) / 2.0
            if abs(center_y_i - center_y_j) <= vertical_threshold:
                group.append(ann_j)
                used[j] = True
        groups.append(group)
    
    merged_annotations = []
    for group in groups:
        group.sort(key=lambda a: a["boundingPoly"]["vertices"][0]["x"])
        
        subgroups = []
        subgroup = []
        for ann in group:
            if not subgroup:
                subgroup.append(ann)
            else:
                last_ann = subgroup[-1]
                last_right = last_ann["boundingPoly"]["vertices"][1]["x"]
                current_left = ann["boundingPoly"]["vertices"][0]["x"]
                if current_left - last_right <= horizontal_gap_threshold:
                    subgroup.append(ann)
                else:
                    subgroups.append(subgroup)
                    subgroup = [ann]
        if subgroup:
            subgroups.append(subgroup)
        
        for sub in subgroups:
            merged_text = " ".join([a["description"] for a in sub])
            left = min(a["boundingPoly"]["vertices"][0]["x"] for a in sub)
            top = min(a["boundingPoly"]["vertices"][0]["y"] for a in sub)
            right = max(a["boundingPoly"]["vertices"][1]["x"] for a in sub)
            bottom = max(a["boundingPoly"]["vertices"][2]["y"] for a in sub)
            merged_style = f"top: {top}px; left: {left}px; width: {right - left}px; height: {bottom - top}px; transform: rotate(0deg);"
            merged_annotations.append({
                "description": merged_text,
                "boundingPoly": {"vertices": [
                    {"x": left, "y": top},
                    {"x": right, "y": top},
                    {"x": right, "y": bottom},
                    {"x": left, "y": bottom}
                ]},
                "rotate": 0,
                "style": merged_style
            })
    return merged_annotations

@app.route('/ocr', methods=['POST'])
def ocr_endpoint():
    global global_driver, global_first_image, last_request_time
    last_request_time = time.time()
    if 'image' not in request.files:
        return jsonify({"error": "ไม่มีไฟล์ image ใน request"}), 400

    mode = request.form.get("mode", "")
    image_file = request.files['image']
    image_bytes = image_file.read()

    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image_width, image_height = image.size
            image.load()
        base64_image = convert_image_to_base64(image_bytes)

        with driver_lock:
            if global_driver is None:
                logging.info("เปิดเบราว์เซอร์ใหม่...")
                init_driver()
            sb_driver = global_driver
            if not global_first_image:
                if not click_upload_button(sb_driver):
                    logging.info("โหลดหน้า Google Lens ใหม่...")
                    sb_driver.get("https://lens.google.com/")
                    sb_driver.wait_for_element_visible("div.f6GA0", timeout=5)
            drag_and_drop_image(sb_driver, base64_image)
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(process_ocr_sync, mode, sb_driver, image_width, image_height)
                try:
                    result = future.result(timeout=2)
                    job_id = str(uuid.uuid4())
                    jobs[job_id] = {"status": "done", "result": result}
                    if global_first_image:
                        global_first_image = False
                    return jsonify({"job_id": job_id, "status": "done", "result": result})
                except TimeoutError:
                    job_id = str(uuid.uuid4())
                    def wait_future_and_update():
                        try:
                            res = future.result()
                            jobs[job_id] = {"status": "done", "result": res}
                        except Exception as e:
                            jobs[job_id] = {"status": "error", "error": str(e)}
                    threading.Thread(target=wait_future_and_update, daemon=True).start()
                    if global_first_image:
                        global_first_image = False
                    return jsonify({"job_id": job_id, "status": "processing"})
    except Exception as e:
        logging.error(f"❌ Error during OCR processing: {e}")
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
    init_driver()
    from waitress import serve
    serve(app, host='0.0.0.0', port=5000)
