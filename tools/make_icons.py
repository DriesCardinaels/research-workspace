"""Draw the web app icons in static/icons/.

Run: uv run --with pillow python tools/make_icons.py
A blue tile with a white page, a folded corner, text lines and one yellow highlight.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'static' / 'icons'
S = 1024  # draw large, then downscale for smooth edges
ACCENT = (46, 93, 181)  # --accent in style.css
INK = (34, 48, 71)  # --ink
HIGHLIGHT = (255, 214, 102)


def draw() -> Image.Image:
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.225), fill=ACCENT)
    # Page with a folded top-right corner.
    l, t, r, b, fold = 262, 170, 762, 854, 150
    d.polygon([(l, t), (r - fold, t), (r, t + fold), (r, b), (l, b)], fill=(255, 255, 255))
    d.polygon([(r - fold, t), (r - fold, t + fold), (r, t + fold)], fill=(200, 214, 238))
    # Text lines; the third one is highlighted.
    y, x0, x1 = 400, l + 70, r - 70
    for i, end in enumerate([x1, x1, x1 - 40, x1, x1 - 140]):
        if i == 2:
            d.rounded_rectangle((x0 - 18, y - 30, end + 18, y + 30), radius=12, fill=HIGHLIGHT)
        d.rounded_rectangle((x0, y - 11, end, y + 11), radius=11, fill=INK)
        y += 90
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    big = draw()
    for size, name in [(180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
        big.resize((size, size), Image.LANCZOS).save(OUT / name)
        print(OUT / name)


if __name__ == '__main__':
    main()
