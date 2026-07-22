from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

BG = (37, 99, 235, 255)   # blue
FG = (255, 255, 255, 255)  # white check

def make_icon(size, filename, corner_radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * corner_radius_ratio)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    # checkmark, drawn as a thick polyline scaled to the icon
    w = size
    pts = [
        (0.22 * w, 0.54 * w),
        (0.42 * w, 0.74 * w),
        (0.78 * w, 0.30 * w),
    ]
    draw.line(pts, fill=FG, width=max(2, int(w * 0.09)), joint="curve")
    # round the line caps
    r = max(2, int(w * 0.09)) // 2
    for x, y in pts:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=FG)

    img.save(os.path.join(OUT, filename))
    print("wrote", filename, size)

# Maskable icons need full-bleed safe area; keep same design, PNG works for both
make_icon(192, "icon-192.png")
make_icon(512, "icon-512.png")
make_icon(180, "apple-touch-icon.png", corner_radius_ratio=0.0)  # iOS adds its own mask
make_icon(32, "favicon-32.png")
print("done")
