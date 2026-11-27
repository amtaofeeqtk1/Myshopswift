"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../public/assets/cookie-consent.js"), "utf8");
function setup(storage = new Map()) {
  const listeners = new Map();
  const nodes = new Map();
  const overlay = {
    style: {}, innerHTML: "", listeners: {},
    setAttribute() {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    querySelectorAll(selector) { return selector === "[data-category]" ? Object.values(categories) : []; },
    querySelector(selector) { return nodes.get(selector); }
  };
  const categories = {
    personalization: { dataset:{category:"personalization"}, checked:false },
    marketing: { dataset:{category:"marketing"}, checked:false },
    analytics: { dataset:{category:"analytics"}, checked:false }
  };
  function button(selector) { return { disabled:false, listeners:{}, addEventListener(name, fn){this.listeners[name]=fn;}, focus(){}, click(){this.listeners.click?.();} }; }
  nodes.set("[data-action=accept]", button("accept"));
  nodes.set("[data-action=decline]", button("decline"));
  nodes.set("[data-action=save]", button("save"));
  nodes.set(".mss-cookie-close", button("close"));
  const footerBottom = { appendChild(node){ this.button=node; } };
  const footer = { querySelector(){return footerBottom;} };
  const document = {
    head:{appendChild(){}}, body:{style:{},appendChild(){}},
    createElement(tag){return tag==="div"?overlay:{textContent:"",addEventListener(name,fn){this.listeners??={};this.listeners[name]=fn;},click(){this.listeners?.click?.();},type:"",className:""};},
    addEventListener(name, fn){listeners.set(name,fn);}, querySelectorAll(selector){return selector==="footer"?[footer]:[];}
  };
  const localStorage = {getItem(k){return storage.has(k)?storage.get(k):null;},setItem(k,v){storage.set(k,v);}};
  const context = {document, localStorage, window:{}, console, Date, JSON, Object, String, Error};
  vm.runInNewContext(source, context);
  listeners.get("DOMContentLoaded")();
  return {context, overlay, categories, nodes, footerBottom, storage};
}

test("new visitors get an undecided modal and closing does not create consent", () => {
  const app=setup();
  assert.equal(app.overlay.style.display,"flex");
  assert.equal(app.nodes.get(".mss-cookie-close").disabled,true);
  app.nodes.get(".mss-cookie-close").click();
  assert.equal(app.overlay.style.display,"flex");
  assert.equal(app.context.window.MSSCookieConsent.get(),null);
});

test("decline, accept, custom choices, persistence and withdrawal are applied", () => {
  const app=setup(); let analyticsStarts=0, analyticsStops=0;
  app.context.window.MSSCookieConsent.when("analytics",()=>{analyticsStarts++;return()=>analyticsStops++;});
  app.nodes.get("[data-action=decline]").click();
  assert.deepEqual(JSON.parse(JSON.stringify(app.context.window.MSSCookieConsent.get().categories)),{required:true,personalization:false,marketing:false,analytics:false});
  app.footerBottom.button.click(); app.categories.analytics.checked=true; app.categories.personalization.checked=true;
  app.nodes.get("[data-action=save]").click();
  assert.equal(analyticsStarts,1); assert.equal(analyticsStops,0);
  app.footerBottom.button.click(); app.categories.analytics.checked=false;
  app.nodes.get("[data-action=save]").click();
  assert.equal(analyticsStops,1,"withdrawal runs the registered cleanup");
  const returning=setup(app.storage);
  assert.equal(returning.overlay.style.display,undefined);
  assert.equal(returning.categories.analytics.checked,false);
  returning.context.window.MSSCookieConsent.open();
  returning.categories.analytics.checked=false;
  returning.nodes.get("[data-action=save]").click();
  assert.equal(returning.context.window.MSSCookieConsent.get().categories.analytics,false);
  const accepted=setup(new Map()); accepted.nodes.get("[data-action=accept]").click();
  assert.deepEqual(JSON.parse(JSON.stringify(accepted.context.window.MSSCookieConsent.get().categories)),{required:true,personalization:true,marketing:true,analytics:true});
});
