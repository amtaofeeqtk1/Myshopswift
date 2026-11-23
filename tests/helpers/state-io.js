"use strict";
// Saves/loads the fake image-DB state to a JSON file so separate CLI processes can share it.
const fs = require("fs");
const { newState } = require("./fake-image-db");

function enc(v) {
  if (Buffer.isBuffer(v)) return { __buf: v.toString("base64") };
  if (v instanceof Date) return { __date: v.toISOString() };
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [k, enc(x)]) };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
}
function dec(v) {
  if (v && typeof v === "object") {
    if (v.__buf !== undefined) return Buffer.from(v.__buf, "base64");
    if (v.__date !== undefined) return new Date(v.__date);
    if (v.__map) return new Map(v.__map.map(([k, x]) => [k, dec(x)]));
    if (Array.isArray(v)) return v.map(dec);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
  }
  return v;
}
module.exports = {
  save(state, file) { const { sqlLog, failQueries, ...rest } = state; fs.writeFileSync(file, JSON.stringify(enc(rest))); },
  load(file) { return Object.assign(newState(), dec(JSON.parse(fs.readFileSync(file, "utf8")))); }
};
