import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGES, joinList, normLang, t } from "./i18n";

test("English and Dutch have exactly the same keys", () => {
  const en = Object.keys(MESSAGES.en).sort();
  const nl = Object.keys(MESSAGES.nl).sort();
  assert.deepEqual(nl, en);
});

test("no text contains an em dash or en dash", () => {
  for (const [lang, messages] of Object.entries(MESSAGES)) {
    for (const [key, value] of Object.entries(messages)) {
      assert.doesNotMatch(value, /[–—]/, `${lang} ${key}`);
    }
  }
});

test("every text is filled in and uses the same {placeholders} in both languages", () => {
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
    assert.ok(MESSAGES.en[key].trim(), `en ${key} is empty`);
    assert.ok(MESSAGES.nl[key].trim(), `nl ${key} is empty`);
    assert.deepEqual(vars(MESSAGES.nl[key]), vars(MESSAGES.en[key]), key);
  }
});

test("t interpolates, and an unknown language falls back to English", () => {
  assert.equal(t("en", "overlay.tipNowTitle", { key: "Ctrl+Shift+Space" }), "Get a tip now (Ctrl+Shift+Space)");
  assert.equal(t("nl", "overlay.tipNowTitle", { key: "Ctrl+Shift+Space" }), "Geef nu een tip (Ctrl+Shift+Space)");
  assert.equal(t("nl-NL", "status.stopped"), "Gestopt");
  assert.equal(t("de", "status.stopped"), "Stopped");
  assert.equal(t(undefined, "status.stopped"), "Stopped");
  assert.equal(t("en", "main.missingKey"), "No {label} set. Open the settings.");
  assert.equal(normLang("NL"), "nl");
  assert.equal(normLang("fr"), "en");
});

test("joinList uses the word for 'and' of the language", () => {
  assert.equal(joinList("en", ["a"]), "a");
  assert.equal(joinList("en", ["a", "b", "c"]), "a, b and c");
  assert.equal(joinList("nl", ["a", "b"]), "a en b");
});
