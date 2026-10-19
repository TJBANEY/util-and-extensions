"""Generate extension icons (card + deal badge motif)."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(OUT, exist_ok=True)


def make(size):
    S = 8  # supersample
    W = size * S
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # background rounded square (slate)
    r = W * 0.22
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=r, fill=(17, 24, 39, 255))
    # card (white, slightly rotated look via offset shadow)
    cx0, cy0, cx1, cy1 = W * 0.26, W * 0.16, W * 0.74, W * 0.84
    d.rounded_rectangle([cx0 + W * 0.03, cy0 + W * 0.03, cx1 + W * 0.03, cy1 + W * 0.03], radius=W * 0.06, fill=(0, 0, 0, 90))
    d.rounded_rectangle([cx0, cy0, cx1, cy1], radius=W * 0.06, fill=(248, 250, 252, 255), outline=(203, 213, 225, 255), width=max(1, W // 64))
    # card art area (teal→gold-ish block)
    d.rounded_rectangle([cx0 + W * 0.06, cy0 + W * 0.07, cx1 - W * 0.06, cy0 + W * 0.40], radius=W * 0.03, fill=(15, 118, 110, 255))
    d.rounded_rectangle([cx0 + W * 0.06, cy0 + W * 0.47, cx1 - W * 0.06, cy0 + W * 0.52], radius=W * 0.01, fill=(203, 213, 225, 255))
    d.rounded_rectangle([cx0 + W * 0.06, cy0 + W * 0.56, cx1 - W * 0.18, cy0 + W * 0.61], radius=W * 0.01, fill=(203, 213, 225, 255))
    # green deal badge (circle) bottom-right with $
    bx, by, br = W * 0.72, W * 0.72, W * 0.20
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=(22, 163, 74, 255), outline=(187, 247, 208, 255), width=max(1, W // 40))
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(br * 1.5))
    except Exception:
        font = ImageFont.load_default()
    tw, th = d.textbbox((0, 0), '$', font=font)[2:]
    d.text((bx - tw / 2, by - th / 2 - br * 0.12), '$', font=font, fill=(255, 255, 255, 255))
    img = img.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, f'icon{size}.png'))


for s in (16, 32, 48, 128):
    make(s)
print('icons written')
