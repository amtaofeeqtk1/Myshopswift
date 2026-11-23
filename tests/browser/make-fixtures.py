"""Creates real and invalid sample files for tests/browser/product-upload.py.  Usage: python3 make-fixtures.py /tmp/fx  (needs Pillow)"""
import os, random, sys
from PIL import Image, ImageDraw
out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fx"
os.makedirs(out, exist_ok=True); os.chdir(out); random.seed(1)
def pic(w, h, alpha=False):
    im = Image.new("RGBA" if alpha else "RGB", (w, h), (15, 42, 107, 255) if alpha else (15, 42, 107))
    d = ImageDraw.Draw(im)
    for _ in range(400):
        x, y, r = random.randrange(w), random.randrange(h), random.randrange(20, 200)
        d.ellipse([x-r, y-r, x+r, y+r], fill=tuple(random.randrange(256) for _ in range(3)) + ((255,) if alpha else ()))
    return im
pic(800, 600).save("small.jpg", quality=85); pic(800, 600, True).save("small.png"); pic(800, 600).save("small.webp", quality=85)
pic(4032, 3024).save("phone-photo.jpg", quality=97)
pic(300, 200).save("small.gif")
open("fake.png", "wb").write(b"<html><script>alert(1)</script></html>" * 50)
open("notes.txt", "wb").write(b"hello" * 100)
open("pic.gif", "wb").write(b"GIF89a" + b"\x00" * 200)
open("vector.svg", "wb").write(b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
open("huge.jpg", "wb").write(b"\xff\xd8\xff\xe0" + os.urandom(5 * 1024 * 1024 + 10))
print("fixtures written to", out)
