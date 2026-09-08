"""Image normalization shared by API and queued jobs."""

from PIL import Image

def image_to_rgb(src: Image.Image) -> Image.Image:
    if "A" not in src.getbands() and "transparency" not in src.info:
        return src.convert("RGB")
    rgba = src.convert("RGBA")
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    return Image.alpha_composite(white, rgba).convert("RGB")
