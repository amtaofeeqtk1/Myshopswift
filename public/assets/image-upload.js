// MyShopSwift admin — photo upload field
//
// Replaces typing an image path. The admin picks a photo from their phone
// gallery / camera roll / computer, sees a preview straight away, watches an
// upload progress bar, and can replace or remove it before saving.
//
// How it fits the existing admin page: the field keeps writing the photo's URL
// into the same hidden <input> (#pImage / #cImage) that the page's existing
// save code already reads, so "Save" / "Publish live" and the database column
// are unchanged. Uploading happens as soon as a photo is chosen, but nothing
// on the shop changes until the product is saved and published, and nothing
// is ever deleted: Replace/Remove only change the URL on the product.
//
// Phone photos are 3-8MB; the page shrinks them in the browser (longest side
// 1600px) before upload, so images stay small and uploads are quick on mobile
// data. The server independently re-validates type and size.
(function () {
  var ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
  var EXT_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  var MAX_UPLOAD_BYTES = 5 * 1024 * 1024;   // what the server accepts
  var MAX_SOURCE_BYTES = 30 * 1024 * 1024;  // biggest original we'll even try to shrink
  var MAX_SIDE = 1600;

  function fileType(file) {
    var t = (file.type || "").toLowerCase();
    if (t === "image/jpg" || t === "image/pjpeg") return "image/jpeg";
    if (ALLOWED_TYPES.indexOf(t) !== -1) return t;
    if (!t || t === "application/octet-stream") { // some Android file managers send no type
      var ext = (file.name || "").split(".").pop().toLowerCase();
      return EXT_TYPES[ext] || null;
    }
    return null;
  }

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }
  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }
  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
  }

  // Shrinks big photos in the browser. Falls back to the original file if
  // anything about that goes wrong, so a failed resize never blocks an upload.
  function prepare(file, type) {
    if (file.size <= 400 * 1024) return Promise.resolve(file);
    return loadBitmap(file).then(function (bmp) {
      var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
      var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      if (scale === 1 && file.size <= 1.5 * 1024 * 1024) return file;
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      if (bmp.close) bmp.close();
      return toBlob(canvas, type, 0.86).then(function (blob) {
        if (!blob || blob.size >= file.size) return file;
        var ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
        var base = (file.name || "photo").replace(/\.[^.]+$/, "");
        return new File([blob], base + "." + ext, { type: blob.type });
      });
    }).catch(function () { return file; });
  }

  // Plain-English reason for a failed upload. res = { status, data }:
  // status 0 = network error, -1 = timeout, otherwise the HTTP status.
  function describeFailure(res) {
    if (res.status === 0) return "Network error. Check your connection and try again.";
    if (res.status === -1) return "The upload took too long. Check your connection and try again.";
    if (res.data && res.data.error) return res.data.error;
    if (res.status === 401 || res.status === 403) return "Your admin session has expired. Sign in again, then retry.";
    if (res.status === 413) return "That image is too large. Choose a smaller photo.";
    if (res.status === 429) return "Too many uploads. Wait a few minutes and try again.";
    return "The upload failed (error " + res.status + "). Please try again.";
  }

  // XMLHttpRequest wrapper with upload progress (fetch can't report it).
  // opts: { url, method, formData, onProgress(percent), timeout }
  function send(opts) {
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest();
      x.open(opts.method || "POST", opts.url);
      x.withCredentials = true;
      x.timeout = opts.timeout || 180000;
      x.upload.onprogress = function (e) {
        if (opts.onProgress && e.lengthComputable) opts.onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      };
      function done(status, body) {
        var data = null; try { data = JSON.parse(body); } catch (e) { /* not json */ }
        resolve({ status: status, data: data });
      }
      x.onload = function () { done(x.status, x.responseText); };
      x.onerror = function () { done(0, ""); };
      x.ontimeout = function () { done(-1, ""); };
      x.send(opts.formData);
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // opts: { root, input (hidden input holding the URL), endpoint, onBusyChange(busy) }
  function attach(opts) {
    var root = opts.root, valueInput = opts.input;
    root.className = "img-up";

    var preview = el("div", "img-up-preview");
    var img = el("img"); img.alt = ""; img.hidden = true;
    var empty = el("span", "img-up-empty", "No photo");
    preview.appendChild(img); preview.appendChild(empty);

    var side = el("div", "img-up-side");
    var actions = el("div", "img-up-actions");
    var chooseBtn = el("button", "btn btn-outline btn-sm", "Choose photo"); chooseBtn.type = "button";
    var removeBtn = el("button", "btn btn-danger btn-sm", "Remove"); removeBtn.type = "button";
    actions.appendChild(chooseBtn); actions.appendChild(removeBtn);

    var progress = el("div", "img-up-progress"); progress.hidden = true;
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100");
    var track = el("div", "img-up-track"); var bar = el("div", "img-up-bar"); track.appendChild(bar);
    var pct = el("span", "img-up-pct", "0%");
    progress.appendChild(track); progress.appendChild(pct);

    var note = el("div", "img-up-note");
    var error = el("div", "img-up-error"); error.hidden = true; error.setAttribute("role", "alert");

    var fileInput = el("input", "file-input"); fileInput.type = "file";
    // Image types only (not "*"), so phones offer the photo library as well as files.
    fileInput.accept = "image/jpeg,image/png,image/webp";

    side.appendChild(actions); side.appendChild(progress); side.appendChild(note); side.appendChild(error);
    root.appendChild(preview); root.appendChild(side); root.appendChild(fileInput);

    var busy = false, seq = 0, xhr = null, localUrl = null;

    function setBusy(b) {
      busy = b;
      chooseBtn.disabled = b; removeBtn.disabled = b;
      if (opts.onBusyChange) opts.onBusyChange(b);
    }
    function showError(msg) { error.textContent = msg; error.hidden = !msg; }
    function setProgress(p, label) {
      progress.hidden = p === null;
      if (p === null) return;
      bar.style.width = p + "%";
      pct.textContent = label || (p + "%");
      progress.setAttribute("aria-valuenow", String(p));
    }
    function freeLocalUrl() { if (localUrl) { URL.revokeObjectURL(localUrl); localUrl = null; } }

    function showPreview(src) {
      if (src) { img.src = window.cdnImg ? window.cdnImg(src, 224) : src; img.hidden = false; empty.hidden = true; }
      else { img.removeAttribute("src"); img.hidden = true; empty.hidden = false; }
    }
    img.addEventListener("error", function () {
      if (img.getAttribute("src")) { img.hidden = true; empty.textContent = "Can't display"; empty.hidden = false; }
    });

    // Re-draws the field from the hidden input's current value.
    function render(message) {
      var v = valueInput.value.trim();
      empty.textContent = "No photo";
      showPreview(v);
      chooseBtn.textContent = v ? "Replace photo" : "Choose photo";
      removeBtn.hidden = !v;
      note.textContent = message || (v ? "Current photo" : "");
    }

    function setValue(v) {
      seq++; if (xhr) { xhr.abort(); xhr = null; }
      freeLocalUrl();
      valueInput.value = v || "";
      setBusy(false); setProgress(null); showError("");
      render();
    }

    function uploadFile(file, mySeq) {
      return new Promise(function (resolve) {
        var fd = new FormData();
        fd.append("image", file, file.name);
        xhr = new XMLHttpRequest();
        xhr.open("POST", opts.endpoint);
        xhr.withCredentials = true;
        xhr.timeout = 90000;
        xhr.upload.onprogress = function (e) {
          if (mySeq !== seq || !e.lengthComputable) return;
          var p = Math.min(99, Math.round((e.loaded / e.total) * 100));
          setProgress(p, p + "%");
        };
        function done(status, body) {
          xhr = null;
          var data = null; try { data = JSON.parse(body); } catch (e) { /* not json */ }
          resolve({ status: status, data: data });
        }
        xhr.onload = function () { done(xhr.status, xhr.responseText); };
        xhr.onerror = function () { done(0, ""); };
        xhr.ontimeout = function () { done(-1, ""); };
        xhr.onabort = function () { done(-2, ""); };
        xhr.send(fd);
      });
    }

    function failureMessage(res) { return describeFailure(res); }

    function handleFile(file) {
      showError("");
      var type = fileType(file);
      if (!type) {
        showError("That file type isn't supported. Choose a JPG, PNG or WebP image.");
        return;
      }
      if (file.size === 0) { showError("That file is empty. Choose another photo."); return; }
      if (file.size > MAX_SOURCE_BYTES) {
        showError("That photo is too large (over 30MB). Choose a smaller one.");
        return;
      }

      var mySeq = ++seq;
      var previousValue = valueInput.value;
      freeLocalUrl();
      localUrl = URL.createObjectURL(file);
      showPreview(localUrl);            // instant preview, before anything is uploaded
      removeBtn.hidden = false;
      note.textContent = file.name;
      setBusy(true);
      setProgress(0, "Preparing…");

      prepare(file, type).then(function (ready) {
        if (mySeq !== seq) return null;
        if (ready.size > MAX_UPLOAD_BYTES) {
          return { status: 413, data: { error: "That image is still larger than 5MB after resizing. Choose a smaller photo." } };
        }
        setProgress(0, "0%");
        return uploadFile(ready, mySeq);
      }).then(function (res) {
        if (mySeq !== seq || !res) return;
        setBusy(false);
        if (res.status === 201 && res.data && res.data.url) {
          setProgress(100, "Uploaded");
          setTimeout(function () { if (mySeq === seq) setProgress(null); }, 900);
          valueInput.value = res.data.url;
          valueInput.dispatchEvent(new Event("change", { bubbles: true }));
          chooseBtn.textContent = "Replace photo";
          removeBtn.hidden = false;
          note.textContent = "Uploaded. Click Save to keep this photo.";
        } else {
          // Upload failed: put the previous photo back so nothing is lost.
          setProgress(null);
          freeLocalUrl();
          valueInput.value = previousValue;
          render();
          showError(failureMessage(res));
        }
      });
    }

    chooseBtn.addEventListener("click", function () { if (!busy) fileInput.click(); });
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = ""; // lets the same photo be chosen again after an error
      if (f) handleFile(f);
    });
    removeBtn.addEventListener("click", function () {
      if (busy) return;
      freeLocalUrl();
      valueInput.value = "";
      valueInput.dispatchEvent(new Event("change", { bubbles: true }));
      showError("");
      render("Photo removed. Click Save to apply.");
    });

    render();
    return { setValue: setValue, isBusy: function () { return busy; } };
  }

  window.MSSImageUpload = { attach: attach, send: send, describeFailure: describeFailure };
})();
