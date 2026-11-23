"""
Real-browser (Chromium) check of the admin photo upload field.
Needs: python3 + playwright + a Chromium, and the fake-DB server:
    node tests/e2e-product-images.js --serve &
    FIXTURES=/tmp/fx python3 tests/browser/product-upload.py
Mobile checks use Chromium's phone *emulation* (viewport, touch, user agent); they
are not a substitute for trying a real Android phone and a real iPhone.
"""
import json, os, re, sys, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE", "http://127.0.0.1:38124")
FX = os.environ.get("FIXTURES", "/tmp/fx")
SHOTS = os.environ.get("SHOTS", "/tmp/shots")
passed = failed = 0

def step(name):
    def deco(fn):
        global passed, failed
        try:
            fn(); passed += 1; print("  ok  -", name)
        except Exception as e:
            failed += 1; print("  FAIL-", name, "\n       ", " | ".join(l.strip() for l in str(e).strip().split("\n")[:8])[:900])
        return fn
    return deco

def api(path):
    return json.load(urllib.request.urlopen(BASE + path))

CLOUD_RE = r"^https://res\.cloudinary\.com/demo-cloud/image/upload/v\d+/myshopswift/(products|categories|flyers)/[0-9a-f-]{36}\.(jpg|png|webp|gif)$"
cdn_requests = []          # every URL the browser asked res.cloudinary.com for
def cdn_stub(route):
    """The sandbox is offline, so answer Cloudinary delivery requests with a real image."""
    cdn_requests.append(route.request.url)
    route.fulfill(status=200, content_type="image/jpeg", body=open(f"{FX}/small.jpg", "rb").read())

def tr(url, w):
    """What cdnImg() should turn a Cloudinary URL into."""
    return url.replace("/image/upload/", f"/image/upload/f_auto,q_auto,c_limit,w_{w}/", 1)

def multipart_file(body):
    """Extract the uploaded file's bytes from a captured multipart request body."""
    start = body.index(b"\r\n\r\n", body.index(b'name="image"')) + 4
    return body[start: body.rindex(b"\r\n--")]

def open_admin(ctx):
    page = ctx.new_page()
    page.goto(BASE + "/admin.html")
    page.wait_for_selector("#addProductBtn", state="visible", timeout=15000)
    return page

def new_ctx(browser, **kw):
    ctx = browser.new_context(**kw)
    ctx.add_cookies([{"name": "admin_session", "value": "admintoken", "url": BASE}])
    return ctx

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ------------------------------------------------------------ desktop
    ctx = new_ctx(browser, viewport={"width": 1280, "height": 900})
    ctx.route("https://res.cloudinary.com/**", cdn_stub)
    page = open_admin(ctx)
    page.on("dialog", lambda d: d.accept())

    @step("product form has an upload field and no free-text image-path box")
    def _():
        page.click("#addProductBtn")
        expect(page.locator("#pImageUpload .img-up-preview")).to_be_visible()
        expect(page.locator("#pImageUpload .img-up-progress")).to_be_hidden()      # idle: no stray progress bar
        expect(page.locator("#pImageUpload .img-up-error")).to_be_hidden()
        expect(page.locator("#pImageUpload >> text=Remove")).to_be_hidden()        # nothing to remove yet
        assert page.locator("#pImage").get_attribute("type") == "hidden"
        accept = page.locator("#pImageUpload input[type=file]").get_attribute("accept")
        assert accept == "image/jpeg,image/png,image/webp", accept
        assert "assets/products" not in page.locator("#productModalOverlay").inner_text()
        page.screenshot(path=f"{SHOTS}/1-desktop-empty.png")

    @step("clicking Choose photo opens the device file picker (images only)")
    def _():
        with page.expect_file_chooser() as fc:
            page.click("#pImageUpload >> text=Choose photo")
        assert fc.value.is_multiple() is False

    @step("preview shows immediately (local blob) while the upload is still in flight; Save is disabled; progress is visible")
    def _():
        held = []
        page.route("**/api/admin/product-images", lambda route: held.append(route))   # hold the request open
        try:
            page.set_input_files("#pImageUpload input[type=file]", f"{FX}/small.jpg")
            expect(page.locator("#pImageUpload .img-up-preview img")).to_have_attribute("src", re.compile(r"^blob:"))
            expect(page.locator("#pImageUpload .img-up-progress")).to_be_visible()
            expect(page.locator("#saveProductBtn")).to_be_disabled()
            expect(page.locator("#pImageUpload >> text=Choose photo")).to_be_disabled()
            page.screenshot(path=f"{SHOTS}/2-desktop-uploading.png")
        finally:
            page.unroute("**/api/admin/product-images")   # releases the held request
        expect(page.locator("#pImageUpload .img-up-note")).to_contain_text("Uploaded", timeout=15000)
        url = page.locator("#pImage").input_value()
        assert re.match(CLOUD_RE, url) and url.endswith(".jpg"), url
        expect(page.locator("#saveProductBtn")).to_be_enabled()
        expect(page.locator("#pImageUpload >> text=Replace photo")).to_be_visible()
        page.screenshot(path=f"{SHOTS}/3-desktop-uploaded.png")

    @step("Remove clears the photo before saving; choosing again works")
    def _():
        page.click("#pImageUpload >> text=Remove")
        assert page.locator("#pImage").input_value() == ""
        expect(page.locator("#pImageUpload .img-up-empty")).to_be_visible()
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/small.png")
        expect(page.locator("#pImageUpload .img-up-note")).to_contain_text("Uploaded", timeout=15000)
        assert page.locator("#pImage").input_value().endswith(".png")

    created_url = {}
    @step("save new product with the uploaded photo -> thumbnail in the admin table")
    def _():
        page.fill("#pName", "Browser Test Product"); page.fill("#pPrice", "7.50")
        created_url["u"] = page.locator("#pImage").input_value()
        page.click("#saveProductBtn")
        row = page.locator("#productsBody tr", has_text="Browser Test Product")
        expect(row.locator("img")).to_have_attribute("src", tr(created_url["u"], 96))   # admin thumbnail is an optimised 96px version

    @step("Publish live -> photo is stored in the catalogue and displays on the storefront")
    def _():
        page.click("#publishBtn")
        page.wait_for_timeout(800)
        prods = api("/api/products")["products"]
        mine = [x for x in prods if x["name"] == "Browser Test Product"][0]
        assert mine["image"] == created_url["u"], mine      # the database keeps the plain Cloudinary URL
        shop = ctx.new_page()
        shop.goto(BASE + "/index.html")
        want = tr(created_url["u"], 640)                      # the storefront asks for an optimised 640px WebP/AVIF-capable version
        img = shop.locator(f'img[src="{want}"]').first
        img.wait_for(state="attached", timeout=15000)
        shop.wait_for_function("(u)=>{const i=[...document.images].find(x=>x.getAttribute('src')===u);return i&&i.complete&&i.naturalWidth>0}", arg=want, timeout=15000)
        assert want in cdn_requests
        shop.screenshot(path=f"{SHOTS}/4-storefront.png")
        shop.close()

    @step("edit existing product: current photo is shown, can be replaced, old upload is not deleted")
    def _():
        page.locator("#productsBody tr", has_text="Browser Test Product").locator("text=Edit").click()
        expect(page.locator("#pImageUpload .img-up-preview img")).to_have_attribute("src", tr(created_url["u"], 224))
        expect(page.locator("#pImageUpload .img-up-note")).to_have_text("Current photo")
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/small.webp")
        expect(page.locator("#pImageUpload .img-up-note")).to_contain_text("Uploaded", timeout=15000)
        new = page.locator("#pImage").input_value()
        assert new.endswith(".webp") and new != created_url["u"]
        page.click("#saveProductBtn")
        created_url["u2"] = new

    @step("editing an existing legacy product (path like assets/products/x.jpg) shows its image and keeps it if untouched")
    def _():
        # product 1 in the fake DB has a legacy relative path
        page.locator("#productsBody tr", has_text="Rice").locator("text=Edit").click()
        assert page.locator("#pImage").input_value() == "assets/products/legacy-rice.jpg"
        expect(page.locator("#pImageUpload >> text=Replace photo")).to_be_visible()
        page.click("#saveProductBtn")
        assert "legacy-rice.jpg" in page.locator("#productsBody tr", has_text="Rice").inner_html()

    @step("cancelling an edit after uploading does not change the product")
    def _():
        row = page.locator("#productsBody tr", has_text="Browser Test Product")
        row.locator("text=Edit").click()
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/small.jpg")
        expect(page.locator("#pImageUpload .img-up-note")).to_contain_text("Uploaded", timeout=15000)
        page.keyboard.press("Escape")
        page.evaluate("document.getElementById('productModalOverlay').classList.remove('active')")
        expect(row.locator("img")).to_have_attribute("src", tr(created_url["u2"], 96))

    @step("unsupported file type is rejected in the browser before any upload, with a clear message")
    def _():
        reqs = []
        page.on("request", lambda r: reqs.append(r.url) if "product-images" in r.url else None)
        page.locator("#productsBody tr", has_text="Browser Test Product").locator("text=Edit").click()
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/notes.txt")
        expect(page.locator("#pImageUpload .img-up-error")).to_contain_text("isn't supported")
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/pic.gif")
        expect(page.locator("#pImageUpload .img-up-error")).to_contain_text("isn't supported")
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/vector.svg")
        expect(page.locator("#pImageUpload .img-up-error")).to_contain_text("isn't supported")
        assert reqs == [], reqs
        assert page.locator("#pImage").input_value() == created_url["u2"]   # unchanged
        page.screenshot(path=f"{SHOTS}/5-desktop-error.png")

    @step("a fake image (text renamed .png) is rejected by the SERVER; the previous photo is restored")
    def _():
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/fake.png")
        expect(page.locator("#pImageUpload .img-up-error")).to_contain_text("isn't a valid JPG, PNG or WebP", timeout=15000)
        assert page.locator("#pImage").input_value() == created_url["u2"]
        expect(page.locator("#pImageUpload .img-up-preview img")).to_have_attribute("src", tr(created_url["u2"], 224))

    @step("a >5MB file is stopped in the browser with a clear message (no upload)")
    def _():
        reqs = []
        page.on("request", lambda r: reqs.append(r.url) if "product-images" in r.url else None)
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/huge.jpg")
        expect(page.locator("#pImageUpload .img-up-error")).to_contain_text("5MB", timeout=15000)
        assert reqs == [], reqs

    @step("upload failures show clear messages: network error, server error, expired session")
    def _():
        page.route("**/api/admin/product-images", lambda r: r.abort())
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/small.jpg")
        expect(page.locator("#pImageUpload .img-up-error")).to_contain_text("Network error", timeout=15000)
        page.unroute("**/api/admin/product-images")
        page.route("**/api/admin/product-images", lambda r: r.fulfill(status=500, body="boom"))
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/small.jpg")
        expect(page.locator("#pImageUpload .img-up-error")).to_contain_text("failed (error 500)", timeout=15000)
        page.unroute("**/api/admin/product-images")
        page.route("**/api/admin/product-images", lambda r: r.fulfill(status=401, content_type="application/json", body='{"error":"Unauthorized"}'))
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/small.jpg")
        expect(page.locator("#pImageUpload .img-up-error")).to_contain_text("Unauthorized", timeout=15000)
        page.unroute("**/api/admin/product-images")
        assert page.locator("#pImage").input_value() == created_url["u2"]   # never lost the old photo
        expect(page.locator("#saveProductBtn")).to_be_enabled()

    @step("a 12MP phone photo is shrunk in the browser before upload (max 1600px) and then works")
    def _():
        sizes, bodies = [], []
        def grab(r):
            if "product-images" in r.url and r.method == "POST":
                b = r.post_data_buffer or b""; sizes.append(len(b)); bodies.append(b)
        page.on("request", grab)
        page.set_input_files("#pImageUpload input[type=file]", f"{FX}/phone-photo.jpg")
        expect(page.locator("#pImageUpload .img-up-note")).to_contain_text("Uploaded", timeout=30000)
        orig = os.path.getsize(f"{FX}/phone-photo.jpg")
        assert sizes and sizes[-1] < orig, (sizes, orig)
        data = multipart_file(bodies[-1])     # the file bytes the browser actually uploaded
        from PIL import Image; import io
        w, h = Image.open(io.BytesIO(data)).size
        assert max(w, h) == 1600 and abs(w / h - 4032 / 3024) < 0.01, (w, h)
        print(f"        ({orig//1024}KB 4032x3024 -> {len(data)//1024}KB {w}x{h})")

    @step("category photo upload goes to the category folder (?kind=category) and shows a preview")
    def _():
        page.evaluate("document.getElementById('productModalOverlay').classList.remove('active')")   # close the product form left open above
        page.click('[data-tab="categories"]')
        seen = []
        page.on("request", lambda r: seen.append(r.url) if "product-images" in r.url and r.method == "POST" else None)
        page.click("#addCatBtn")
        page.set_input_files("#cImageUpload input[type=file]", f"{FX}/small.png")
        expect(page.locator("#cImageUpload .img-up-note")).to_contain_text("Uploaded", timeout=15000)
        assert any(u.endswith("?kind=category") for u in seen), seen
        assert re.match(CLOUD_RE, page.locator("#cImage").input_value())
        page.evaluate("document.getElementById('catModalOverlay') && document.getElementById('catModalOverlay').classList.remove('active')")

    @step("flyers: legacy flyer previews in the admin grid; upload shows progress and a success message; new flyer is a Cloudinary URL")
    def _():
        page.click('[data-tab="flyers"]')
        page.click("#loadFlyersBtn")
        card = page.locator("#flyerGrid .flyer-card").first
        expect(card).to_be_visible(timeout=10000)
        src = card.locator("img").get_attribute("src")
        assert src.startswith("/uploads/flyers/"), src               # legacy flyer still served from PostgreSQL
        page.wait_for_function("()=>{const i=document.querySelector('#flyerGrid .flyer-card img');return i&&i.complete&&i.naturalWidth>0}", timeout=10000)
        held = []
        page.route("**/api/admin/flyers", lambda route: held.append(route) if route.request.method == "POST" else route.continue_())
        page.set_input_files("#flyerUploadInput", f"{FX}/small.jpg")
        expect(page.locator("#flyerProgress")).to_be_visible()
        page.screenshot(path=f"{SHOTS}/7-flyer-progress.png")
        page.unroute("**/api/admin/flyers")                          # release the held upload
        expect(page.locator("#toast")).to_contain_text("Uploaded 1 flyer", timeout=15000)
        expect(page.locator("#flyerProgress")).to_be_hidden()
        expect(page.locator("#flyerGrid .flyer-card")).to_have_count(2, timeout=10000)
        urls = [i.get_attribute("src") for i in page.locator("#flyerGrid .flyer-card img").all()]
        assert any(u.startswith("https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto,c_limit,w_480/") for u in urls), urls
        pub = api("/api/flyers")["flyers"]
        assert re.match(CLOUD_RE, pub[-1]["url"]), pub
        page.screenshot(path=f"{SHOTS}/8-flyers-admin.png")

    @step("flyers: a failed upload shows the server's clear message and adds nothing")
    def _():
        page.route("**/api/admin/flyers", lambda r: r.fulfill(status=502, content_type="application/json", body='{"error":"The image storage service is having problems. Please try again shortly."}') if r.request.method == "POST" else r.continue_())
        page.set_input_files("#flyerUploadInput", f"{FX}/small.jpg")
        expect(page.locator("#toast")).to_contain_text("having problems", timeout=10000)
        page.unroute("**/api/admin/flyers")
        expect(page.locator("#flyerGrid .flyer-card")).to_have_count(2)

    @step("flyers: Replace works from the grid")
    def _():
        with page.expect_file_chooser() as fc:
            page.locator("#flyerGrid .flyer-card").last.locator("[data-flyer-replace]").click()
        fc.value.set_files(f"{FX}/small.png")
        expect(page.locator("#toast")).to_contain_text("Flyer replaced", timeout=15000)
        pub = api("/api/flyers")["flyers"]
        assert pub[-1]["url"].endswith(".png"), pub

    ctx.close()

    # ------------------------------------------------------------ phones & tablet (emulation)
    for name, dev in [("Pixel 7 (Android)", p.devices["Pixel 7"]), ("iPhone 14", p.devices["iPhone 14"]), ("iPad (gen 7)", p.devices["iPad (gen 7)"])]:
        ctx = new_ctx(browser, **dev)
        ctx.route("https://res.cloudinary.com/**", cdn_stub)
        page = open_admin(ctx)
        slug = re.sub(r"\W+", "-", name.lower())

        @step(f"{name}: upload field fits the screen, Choose photo is tappable and opens the picker, upload + preview work")
        def _():
            page.click("#addProductBtn")
            modal = page.locator("#productModalOverlay .modal")
            field = page.locator("#pImageUpload")
            field.scroll_into_view_if_needed()
            box = page.locator("#pImageUpload >> text=Choose photo").bounding_box()
            vw = page.viewport_size["width"]
            assert box["height"] >= 36 and box["x"] >= 0 and box["x"] + box["width"] <= vw, (box, vw)
            overflow = page.evaluate("()=>{const m=document.querySelector('#productModalOverlay .modal');return m.scrollWidth-m.clientWidth}")
            assert overflow <= 1, overflow
            with page.expect_file_chooser() as fc:
                page.tap("#pImageUpload >> text=Choose photo")
            fc.value.set_files(f"{FX}/phone-photo.jpg")
            expect(page.locator("#pImageUpload .img-up-note")).to_contain_text("Uploaded", timeout=30000)
            assert re.search(r"\.jpg$", page.locator("#pImage").input_value())
            field.scroll_into_view_if_needed()
            page.screenshot(path=f"{SHOTS}/6-{slug}.png")
        ctx.close()

    browser.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
