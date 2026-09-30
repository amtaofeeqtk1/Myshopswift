/* MyShopSwift AI shopping assistant — storefront widget.
 *
 * Talks to POST /api/ai-assistant and adds items to the storefront's existing
 * basket through window.MyShopSwiftCart (defined in index.html). It keeps no
 * basket of its own and never sees an API key. Everything shown from the server
 * is inserted with textContent / DOM APIs, never innerHTML.
 */
(function(){
  "use strict";

  var MAX_HISTORY = 10;
  var MAX_INPUT = 500;
  var CHIPS = [
    "What's good for breakfast?",
    "Snacks for a party of 10",
    "Something under £10",
    "I need a cheaper alternative"
  ];

  var messages = [];          // conversation sent to the server: { role, content, productIds? }
  var loading = false;
  var ui = {};

  function el(tag, attrs, kids){
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function(k){
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function(c){ if (c) n.appendChild(c); });
    return n;
  }
  function svg(path, extra){
    var wrap = document.createElement("span");
    wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
    var s = wrap.firstChild;
    if (extra) s.setAttribute("class", extra);
    return s;
  }
  var ICON = {
    chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
    send: '<path d="M4 12 20 4l-4 16-4-7z"/><path d="M12 13 20 4"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    reset: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v4h4"/>',
    bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'
  };

  var fmt = function(n){
    return "£" + Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  function cart(){ return window.MyShopSwiftCart || null; }
  function isMobile(){ return window.matchMedia("(max-width:640px)").matches; }

  // ---------- rendering helpers ----------
  function scrollDown(){ ui.log.scrollTop = ui.log.scrollHeight; }

  // Plain text with paragraph breaks and "- " bullet lists. No HTML from the model is ever interpreted.
  function renderText(container, text){
    var list = null;
    String(text).split("\n").forEach(function(line){
      var t = line.trim();
      if (!t){ list = null; return; }
      var bullet = /^[-*•]\s+(.*)$/.exec(t);
      if (bullet){
        if (!list){ list = el("ul"); container.appendChild(list); }
        list.appendChild(el("li", { text: bullet[1] }));
      } else {
        list = null;
        container.appendChild(el("p", { text: t }));
      }
    });
  }

  function addBubble(kind, text){
    var b = el("div", { "class": "msa-msg msa-" + kind });
    renderText(b, text);
    ui.log.appendChild(b);
    scrollDown();
    return b;
  }

  function refreshBasket(){
    var c = cart();
    var s = c ? c.summary() : { count: 0 };
    ui.basketCount.textContent = s.count;
  }

  function viewBasket(){
    var c = cart();
    if (!c) return;
    if (isMobile()) closePanel(false);
    c.openCart();
  }

  // ---------- product card ----------
  function buildCard(p){
    var qty = 1;
    var thumb = el("div", { "class": "msa-thumb" });
    if (p.image){
      var img = el("img", { alt: p.name, loading: "lazy" });
      img.src = p.image;
      img.addEventListener("error", function(){ img.remove(); });
      thumb.appendChild(img);
    }

    var price = el("div", { "class": "msa-price", text: fmt(p.price) });
    if (p.oldPrice) price.appendChild(el("s", { text: fmt(p.oldPrice) }));

    var select = null;
    if (p.brands && p.brands.length){
      select = el("select", { "class": "msa-select", "aria-label": "Brand for " + p.name });
      var ph = el("option", { value: "", text: "Select a brand..." });
      select.appendChild(ph);
      p.brands.forEach(function(b){ var o = el("option", { text: b }); o.value = b; select.appendChild(o); });
    }

    var qtyVal = el("span", { "class": "msa-qty-val", text: "1", "aria-live": "polite" });
    var minus = el("button", { type: "button", "aria-label": "Decrease quantity", text: "–" });
    var plus = el("button", { type: "button", "aria-label": "Increase quantity", text: "+" });
    minus.addEventListener("click", function(){ if (qty > 1){ qty--; qtyVal.textContent = qty; } });
    plus.addEventListener("click", function(){ if (qty < 50){ qty++; qtyVal.textContent = qty; } });

    var add = el("button", { "class": "msa-add", type: "button", text: "Add to Cart" });
    var note = el("div", { "class": "msa-card-note", role: "status" });

    add.addEventListener("click", function(){
      var c = cart();
      note.className = "msa-card-note";
      note.textContent = "";
      if (!c){ note.className += " msa-bad"; note.textContent = "The basket isn't ready yet. Please try again."; return; }
      var brand = select ? select.value : "";
      if (select && !brand){ note.className += " msa-bad"; note.textContent = "Please select a brand."; select.focus(); return; }
      var res = c.addItem({ productId: p.id, qty: qty, brand: brand });
      if (!res.ok){ note.className += " msa-bad"; note.textContent = res.error; return; }
      note.className += " msa-good";
      note.textContent = "Added " + qty + " to your basket.";
      add.classList.add("msa-done");
      add.textContent = "Added";
      setTimeout(function(){ add.classList.remove("msa-done"); add.textContent = "Add to Cart"; }, 1600);
      refreshBasket();
    });

    var body = el("div", { "class": "msa-card-body" }, [
      el("h3", { "class": "msa-card-name", text: p.name }),
      el("div", { "class": "msa-card-meta", text: p.category }),
      price,
      select,
      el("div", { "class": "msa-card-actions" }, [
        el("div", { "class": "msa-qty" }, [minus, qtyVal, plus]),
        add
      ]),
      note
    ]);
    return el("div", { "class": "msa-card" }, [thumb, body]);
  }

  function addCards(products){
    if (!products || !products.length) return;
    var wrap = el("div", { "class": "msa-cards" });
    products.forEach(function(p){ wrap.appendChild(buildCard(p)); });
    ui.log.appendChild(wrap);
    scrollDown();
  }

  // ---------- applying a cart action the server validated ----------
  function applyCartActions(actions){
    var notes = [];
    (actions || []).forEach(function(a){
      var c = cart();
      var res = c ? c.addItem({ productId: a.productId, qty: a.quantity, brand: a.brand }) : { ok: false, error: "The basket isn't ready yet." };
      var bubble;
      if (res.ok){
        bubble = addBubble("notice", "Added " + a.quantity + " × " + a.name + (a.brand ? " (" + a.brand + ")" : "") + " to your basket.");
        var view = el("button", { "class": "msa-inline-btn", type: "button", text: "View basket" });
        view.addEventListener("click", viewBasket);
        bubble.appendChild(document.createElement("br"));
        bubble.appendChild(view);
      } else {
        bubble = addBubble("error", "I couldn't add " + a.name + " to your basket. " + res.error);
        notes.push("[The storefront could not add " + a.name + ": " + res.error + "]");
      }
    });
    refreshBasket();
    return notes.join(" ").slice(0, 180);
  }

  // ---------- talking to the server ----------
  function setLoading(on){
    loading = on;
    ui.input.disabled = on;
    ui.send.disabled = on;
    if (on){
      ui.typing = el("div", { "class": "msa-typing", role: "status", "aria-label": "Assistant is typing" }, [el("span"), el("span"), el("span")]);
      ui.log.appendChild(ui.typing);
      scrollDown();
    } else if (ui.typing){
      ui.typing.remove();
      ui.typing = null;
    }
  }

  function showError(text, canRetry){
    var b = addBubble("error", text);
    if (canRetry){
      var retry = el("button", { "class": "msa-inline-btn", type: "button", text: "Try again" });
      retry.addEventListener("click", function(){ b.remove(); request(); });
      b.appendChild(document.createElement("br"));
      b.appendChild(retry);
    }
  }

  function request(){
    if (loading) return;
    setLoading(true);
    var payload = { messages: messages.slice(-MAX_HISTORY) };
    var timeout = new AbortController();
    var timer = setTimeout(function(){ timeout.abort(); }, 45000);

    fetch("/api/ai-assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
      signal: timeout.signal
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(data){ return { ok: r.ok, status: r.status, data: data }; });
    }).then(function(res){
      clearTimeout(timer);
      setLoading(false);
      if (!res.ok){
        showError(res.data.error || "Something went wrong. Please try again.", res.status !== 400);
        return;
      }
      var d = res.data;
      var products = Array.isArray(d.products) ? d.products : [];
      var entry = { role: "assistant", content: String(d.reply || "").slice(0, 1400), productIds: products.map(function(p){ return p.id; }).slice(0, 6) };
      messages.push(entry);
      addBubble("bot", d.reply);
      addCards(products);
      var note = applyCartActions(d.cartActions);
      if (note) entry.content += " " + note;
      ui.input.focus();
    }).catch(function(err){
      clearTimeout(timer);
      setLoading(false);
      showError(err && err.name === "AbortError"
        ? "That took too long. Please try again."
        : "We couldn't reach the shop just now. Check your connection and try again.", true);
    });
  }

  function send(text){
    text = String(text || "").trim();
    if (!text || loading) return;
    if (text.length > MAX_INPUT) text = text.slice(0, MAX_INPUT);
    if (ui.chips){ ui.chips.remove(); ui.chips = null; }
    messages.push({ role: "user", content: text });
    addBubble("user", text);
    ui.input.value = "";
    autosize();
    request();
  }

  function autosize(){
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(ui.input.scrollHeight, 104) + "px";
  }

  // ---------- open / close / reset ----------
  function openPanel(){
    ui.panel.classList.add("msa-open");
    ui.launcher.hidden = true;
    if (isMobile()) document.documentElement.classList.add("msa-locked");
    refreshBasket();
    setTimeout(function(){ ui.input.focus(); }, 0);
  }
  function closePanel(focusLauncher){
    ui.panel.classList.remove("msa-open");
    ui.launcher.hidden = false;
    document.documentElement.classList.remove("msa-locked");
    if (focusLauncher !== false) ui.launcher.focus();
  }
  function greet(){
    ui.log.textContent = "";
    messages = [];
    addBubble("bot", "Hello, I can help you find products, stay within a budget and add them to your basket. What are you shopping for?");
    ui.chips = el("div", { "class": "msa-chips" });
    CHIPS.forEach(function(c){
      var b = el("button", { "class": "msa-chip", type: "button", text: c });
      b.addEventListener("click", function(){ send(c); });
      ui.chips.appendChild(b);
    });
    ui.log.appendChild(ui.chips);
  }

  // ---------- build the widget ----------
  function build(){
    var root = el("div", { "class": "msa-root" });

    ui.launcher = el("button", { "class": "msa-launcher", type: "button", "aria-label": "Open shopping assistant", "aria-haspopup": "dialog" }, [
      svg(ICON.chat),
      el("span", { "class": "msa-launcher-label", text: "Shopping assistant" })
    ]);

    ui.basketCount = el("span", { text: "0" });
    var basketBtn = el("button", { "class": "msa-head-btn", type: "button", "aria-label": "View basket" }, [svg(ICON.bag), ui.basketCount]);
    var resetBtn = el("button", { "class": "msa-head-btn msa-head-icon", type: "button", "aria-label": "Start a new chat", title: "New chat" }, [svg(ICON.reset)]);
    var closeBtn = el("button", { "class": "msa-head-btn msa-head-icon", type: "button", "aria-label": "Close assistant", title: "Close" }, [svg(ICON.close)]);

    var head = el("div", { "class": "msa-head" }, [
      el("div", { "class": "msa-head-title" }, [
        el("h2", { text: "MyShopSwift Assistant" }),
        el("p", { text: "Find products, add to basket" })
      ]),
      basketBtn, resetBtn, closeBtn
    ]);

    ui.log = el("div", { "class": "msa-log", role: "log", "aria-live": "polite", "aria-label": "Conversation" });

    ui.input = el("textarea", { "class": "msa-input", rows: "1", maxlength: String(MAX_INPUT), placeholder: "Ask for a product, budget or brand", "aria-label": "Message" });
    ui.send = el("button", { "class": "msa-send", type: "button", "aria-label": "Send message" }, [svg(ICON.send)]);
    var composer = el("div", { "class": "msa-composer" }, [ui.input, ui.send]);

    ui.panel = el("section", { "class": "msa-panel", role: "dialog", "aria-label": "MyShopSwift shopping assistant" }, [
      head, el("div", { "class": "msa-stripe" }), ui.log, composer
    ]);

    root.appendChild(ui.launcher);
    root.appendChild(ui.panel);
    document.body.appendChild(root);

    ui.launcher.addEventListener("click", openPanel);
    closeBtn.addEventListener("click", function(){ closePanel(true); });
    resetBtn.addEventListener("click", greet);
    basketBtn.addEventListener("click", viewBasket);
    ui.send.addEventListener("click", function(){ send(ui.input.value); });
    ui.input.addEventListener("input", autosize);
    ui.input.addEventListener("keydown", function(e){
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); send(ui.input.value); }
    });
    ui.panel.addEventListener("keydown", function(e){ if (e.key === "Escape") closePanel(true); });

    // Keep the basket count in step with changes made anywhere on the page.
    var counter = document.getElementById("cartCount");
    if (counter && window.MutationObserver){
      new MutationObserver(refreshBasket).observe(counter, { childList: true, characterData: true, subtree: true });
    }

    greet();
  }

  // Only show the widget when the server says the assistant is configured.
  function init(){
    fetch("/api/ai-assistant/status", { cache: "no-store", credentials: "same-origin" })
      .then(function(r){ return r.ok ? r.json() : { enabled: false }; })
      .then(function(s){ if (s && s.enabled) build(); })
      .catch(function(){ /* server unreachable (e.g. file opened locally): no widget */ });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
