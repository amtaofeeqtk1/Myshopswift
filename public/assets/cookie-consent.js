(function () {
  "use strict";
  var STORAGE_KEY = "mss-cookie-consent-v1";
  var defaults = { required: true, personalization: false, marketing: false, analytics: false };
  var consent = null;
  var subscriptions = [];
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && saved.version === 1 && saved.categories && typeof saved.categories === "object" && saved.updatedAt) {
      consent = { version: 1, updatedAt: saved.updatedAt, categories: {
        required: true,
        personalization: saved.categories.personalization === true,
        marketing: saved.categories.marketing === true,
        analytics: saved.categories.analytics === true
      } };
    }
  } catch (_) {}

  function activateAllowed() {
    subscriptions.forEach(function (subscription) {
      var allowed = !!(consent && consent.categories[subscription.category]);
      try {
        if (allowed && !subscription.cleanup) {
          var cleanup = subscription.activate();
          if (typeof cleanup === "function") subscription.cleanup = cleanup;
          else subscription.cleanup = function () {};
        } else if (!allowed && subscription.cleanup) {
          subscription.cleanup();
          subscription.cleanup = null;
        }
      } catch (e) { console.error("Consent-gated feature failed:", e); }
    });
  }
  window.MSSCookieConsent = {
    get: function () { return consent ? JSON.parse(JSON.stringify(consent)) : null; },
    when: function (category, activate) {
      if (["personalization", "marketing", "analytics"].indexOf(category) < 0 || typeof activate !== "function") return false;
      subscriptions.push({ category: category, activate: activate, cleanup: null });
      activateAllowed();
      return true;
    },
    open: function () { show(true); }
  };

  var style = document.createElement("style");
  style.textContent = `
    .mss-cookie-overlay{position:fixed;inset:0;background:rgba(10,20,45,.62);z-index:99990;display:flex;align-items:center;justify-content:center;padding:20px;}
    .mss-cookie-modal{position:relative;width:min(680px,100%);max-height:min(88vh,820px);overflow:auto;background:#fff;color:#172445;border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.3);font:15px/1.55 'Work Sans',Arial,sans-serif;padding:30px;}
    .mss-cookie-modal h2{font:700 25px/1.2 'Poppins',Arial,sans-serif;color:#0F2A6B;margin:0 42px 8px 0;}
    .mss-cookie-modal h3{font:600 17px 'Poppins',Arial,sans-serif;color:#0F2A6B;margin:20px 0 5px;}
    .mss-cookie-modal p{margin:0;color:#526078;font-size:14px;}
    .mss-cookie-close{position:absolute;right:20px;top:18px;border:0;background:#f1f4f9;border-radius:50%;width:38px;height:38px;font-size:22px;color:#0F2A6B;cursor:pointer;}
    .mss-cookie-close:disabled{opacity:.4;cursor:not-allowed;}
    .mss-cookie-intro{background:#f4f6fa;border-left:4px solid #FF6B00;padding:14px 16px;margin:18px 0 4px;}
    .mss-cookie-option{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:13px 0;border-bottom:1px solid #e5e9f0;}
    .mss-cookie-option strong{display:block;color:#182544;font-size:14px;}
    .mss-cookie-option p{font-size:12.5px;max-width:510px;margin-top:2px;}
    .mss-cookie-switch{flex:none;position:relative;width:48px;height:27px;}
    .mss-cookie-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;}
    .mss-cookie-switch span{position:absolute;inset:0;background:#c7cedb;border-radius:20px;pointer-events:none;transition:.2s;}
    .mss-cookie-switch span:after{content:'';position:absolute;width:19px;height:19px;top:4px;left:4px;background:#fff;border-radius:50%;box-shadow:0 1px 3px #778;transition:.2s;}
    .mss-cookie-switch input:checked+span{background:#0F2A6B;}.mss-cookie-switch input:checked+span:after{transform:translateX(21px);}
    .mss-cookie-switch input:disabled{cursor:default;}.mss-cookie-switch input:focus-visible+span{outline:3px solid #FF6B00;outline-offset:2px;}
    .mss-cookie-required{font-size:11px;color:#2F6E4E;white-space:nowrap;font-weight:600;}
    .mss-cookie-actions{display:flex;justify-content:flex-end;gap:9px;flex-wrap:wrap;margin-top:22px;}
    .mss-cookie-actions button{border:1px solid #0F2A6B;border-radius:5px;padding:10px 16px;background:#fff;color:#0F2A6B;font:600 13px 'Work Sans',Arial;cursor:pointer;}
    .mss-cookie-actions .mss-accept{background:#FF6B00;border-color:#FF6B00;color:#101f4d;}
    .mss-cookie-footer{border:0;background:none;color:inherit;text-decoration:underline;padding:0;font:inherit;cursor:pointer;}
    @media(max-width:560px){.mss-cookie-overlay{padding:10px;align-items:flex-end}.mss-cookie-modal{padding:22px 18px;border-radius:12px 12px 6px 6px;max-height:92vh}.mss-cookie-modal h2{font-size:21px}.mss-cookie-actions{display:grid;grid-template-columns:1fr}.mss-cookie-actions button{width:100%}}
  `;
  document.head.appendChild(style);
  var overlay, toggles = {};
  function makeModal() {
    overlay = document.createElement("div"); overlay.className = "mss-cookie-overlay"; overlay.setAttribute("role", "presentation");
    overlay.innerHTML = `<section class="mss-cookie-modal" role="dialog" aria-modal="true" aria-labelledby="mss-cookie-title" aria-describedby="mss-cookie-desc">
      <button class="mss-cookie-close" type="button" aria-label="Close preferences">×</button>
      <h2 id="mss-cookie-title">Cookie and privacy preferences</h2>
      <div class="mss-cookie-intro"><h3>You control your data</h3><p id="mss-cookie-desc">We use cookies to keep MyShopSwift secure and make shopping work. With your permission, we can also remember preferences and use analytics or marketing technologies. You can change or withdraw your choices at any time.</p></div>
      <div class="mss-cookie-option"><div><strong>Required</strong><p>Necessary for essential website functionality, including login, your basket, checkout and security.</p></div><span class="mss-cookie-required">Always on</span></div>
      <div class="mss-cookie-option"><div><strong>Personalization</strong><p>Remembers your preferences and personalizes your shopping experience.</p></div><label class="mss-cookie-switch"><input type="checkbox" data-category="personalization" aria-label="Allow personalization cookies"><span></span></label></div>
      <div class="mss-cookie-option"><div><strong>Marketing</strong><p>Supports marketing, advertising and relevant promotions.</p></div><label class="mss-cookie-switch"><input type="checkbox" data-category="marketing" aria-label="Allow marketing cookies"><span></span></label></div>
      <div class="mss-cookie-option"><div><strong>Analytics</strong><p>Helps us understand website traffic, visitor behaviour and performance.</p></div><label class="mss-cookie-switch"><input type="checkbox" data-category="analytics" aria-label="Allow analytics cookies"><span></span></label></div>
      <div class="mss-cookie-actions"><button type="button" data-action="decline">Decline all</button><button type="button" data-action="save">Save my choices</button><button type="button" class="mss-accept" data-action="accept">Accept all</button></div>
    </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll("[data-category]").forEach(function (input) { toggles[input.dataset.category] = input; });
    overlay.querySelector("[data-action=accept]").addEventListener("click", function () { save({ required:true, personalization:true, marketing:true, analytics:true }); });
    overlay.querySelector("[data-action=decline]").addEventListener("click", function () { save(defaults); });
    overlay.querySelector("[data-action=save]").addEventListener("click", function () { save({ required:true, personalization:toggles.personalization.checked, marketing:toggles.marketing.checked, analytics:toggles.analytics.checked }); });
    overlay.querySelector(".mss-cookie-close").addEventListener("click", function () { if (consent) hide(); });
    overlay.addEventListener("keydown", function (e) { if (e.key === "Escape" && consent) hide(); });
  }
  function show(edit) {
    if (!overlay) makeModal();
    Object.keys(toggles).forEach(function (key) { toggles[key].checked = consent ? consent.categories[key] : false; });
    overlay.querySelector(".mss-cookie-close").disabled = !consent;
    overlay.style.display = "flex";
    document.body.style.overflow = "hidden";
    var first = overlay.querySelector(edit && consent ? ".mss-cookie-close" : "[data-action=decline]"); first.focus();
  }
  function hide() { if (overlay) overlay.style.display = "none"; document.body.style.overflow = ""; }
  function save(categories) {
    consent = { version:1, updatedAt:new Date().toISOString(), categories:categories };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(consent)); } catch (_) {}
    activateAllowed(); hide();
  }
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("footer").forEach(function (footer) {
      var list = footer.querySelector(".foot-bottom") || footer;
      var button = document.createElement("button"); button.type = "button"; button.className = "mss-cookie-footer"; button.textContent = "Cookie preferences";
      button.addEventListener("click", function () { show(true); }); list.appendChild(button);
    });
    if (!consent) show(false); else activateAllowed();
  });
})();
