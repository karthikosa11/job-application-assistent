"""
Generate clean extension icons (16, 48, 128 px) using Pillow.
Run: python tools/generate_icons.py
"""
import os
import math
from PIL import Image, ImageDraw

SIZES = [16, 48, 128]
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "extension", "assets")

# ── Palette ──────────────────────────────────────────────────────────────────
BG        = (27,  26, 85)    # deep indigo  #1B1A55
ACCENT    = (91,  91, 214)   # primary      #5B5BD6
WHITE     = (255, 255, 255)
LIGHT     = (200, 200, 240)


def round_rect(draw, xy, radius, fill):
    """Draw a rounded rectangle on `draw`."""
    x0, y0, x1, y1 = xy
    draw.rectangle([x0 + radius, y0, x1 - radius, y1], fill=fill)
    draw.rectangle([x0, y0 + radius, x1, y1 - radius], fill=fill)
    draw.ellipse([x0, y0, x0 + 2*radius, y0 + 2*radius], fill=fill)
    draw.ellipse([x1 - 2*radius, y0, x1, y0 + 2*radius], fill=fill)
    draw.ellipse([x0, y1 - 2*radius, x0 + 2*radius, y1], fill=fill)
    draw.ellipse([x1 - 2*radius, y1 - 2*radius, x1, y1], fill=fill)


def draw_bolt(draw, cx, cy, size, color):
    """Draw a lightning bolt centred at (cx, cy) within `size` box."""
    # Lightning bolt polygon points (relative, -0.5..0.5 coords)
    s = size
    pts = [
        (cx + s * 0.10,  cy - s * 0.50),   # top-right of upper wing
        (cx - s * 0.08,  cy - s * 0.02),   # notch left
        (cx + s * 0.14,  cy - s * 0.02),   # notch right
        (cx - s * 0.10,  cy + s * 0.50),   # bottom-left
        (cx + s * 0.08,  cy + s * 0.02),   # notch right-low
        (cx - s * 0.14,  cy + s * 0.02),   # notch left-low
    ]
    draw.polygon(pts, fill=color)


def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = max(1, size // 14)
    r   = max(2, size // 5)

    # Background rounded square
    round_rect(draw, [pad, pad, size - pad, size - pad], r, ACCENT)

    # Lightning bolt (white)
    cx = size / 2
    cy = size / 2 + size * 0.02
    bolt_size = size * 0.38
    draw_bolt(draw, cx, cy, bolt_size, WHITE)

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for sz in SIZES:
        icon = make_icon(sz)
        path = os.path.join(OUT_DIR, f"icon-{sz}.png")
        icon.save(path, "PNG")
        print(f"  saved {path}")
    print("Done.")


if __name__ == "__main__":
    main()
