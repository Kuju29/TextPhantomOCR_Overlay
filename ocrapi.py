from flask import Flask, request, jsonify
from flask_cors import CORS
import os, re, base64, time, logging, threading
from seleniumbase import Driver
from PIL import Image
from io import BytesIO

logging.basicConfig(level=logging.INFO)
app = Flask(__name__)
CORS(app)

driver_lock = threading.Lock()
global_driver = None
global_first_image = True

def init_driver():
    global global_driver
    global_driver = Driver(uc=True, headless=True)
    global_driver.get("https://lens.google.com/")
    global_driver.wait_for_element_visible("div.f6GA0", timeout=10)

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
    logging.info("🔄 ดึงข้อมูล OCR (ข้อความและตำแหน่ง)...")
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


@app.route('/ocr', methods=['POST'])
def ocr_endpoint():
    global global_first_image
    if 'image' not in request.files:
        return jsonify({"error": "ไม่มีไฟล์ image ใน request"}), 400
    
    image_file = request.files['image']
    image_bytes = image_file.read()
    
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image_width, image_height = image.size
            image.load()
        
        base64_image = convert_image_to_base64(image_bytes)
        
        with driver_lock:
            sb_driver = global_driver
            if global_first_image:
                logging.info("🌐 เปิด Google Lens ครั้งแรก...")
                sb_driver.get("https://lens.google.com/")
                sb_driver.wait_for_element_visible("div.f6GA0", timeout=5)
                global_first_image = False
            else:
                if not click_upload_button(sb_driver):
                    sb_driver.get("https://lens.google.com/")
                    sb_driver.wait_for_element_visible("div.f6GA0", timeout=5)
            
            drag_and_drop_image(sb_driver, base64_image)
            
            try:
                sb_driver.wait_for_element_visible("div.lv6PAb", timeout=10)
            except Exception as e:
                logging.error("ไม่พบผล OCR ในเวลาที่กำหนด")
                return jsonify({"error": "ไม่พบผล OCR"}), 500
            
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
        
        response = {
            "textAnnotations": merged_annotations,
            "rawTextAnnotations": text_annotations,
            "fullTextAnnotation": {
                "text": full_text.strip()
            }
        }
            
    except Exception as e:
        logging.error(f"❌ Error during OCR processing: {e}")
        return jsonify({"error": str(e)}), 500
    
    return jsonify(response)

if __name__ == '__main__':
    init_driver()
    app.run(host='0.0.0.0', port=5000)
