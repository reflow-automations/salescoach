// Fills the static text of a page from the dictionary. Elements opt in with attributes:
//   data-i18n="key"              textContent (use it only on elements without child elements)
//   data-i18n-title="key"        title
//   data-i18n-placeholder="key"  placeholder
//   data-i18n-aria="key"         aria-label
// Safe to run again when the language changes: it only touches text, never the value of an input.
import { isMessageKey, normLang, t } from "../shared/i18n";

const ATTRS: [string, (el: HTMLElement, text: string) => void][] = [
  ["i18n", (el, text) => (el.textContent = text)],
  ["i18nTitle", (el, text) => (el.title = text)],
  ["i18nPlaceholder", (el, text) => el.setAttribute("placeholder", text)],
  ["i18nAria", (el, text) => el.setAttribute("aria-label", text)],
];

export function applyI18n(lang: string, root: ParentNode = document): void {
  document.documentElement.lang = normLang(lang);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria]"))) {
    for (const [name, set] of ATTRS) {
      const key = el.dataset[name];
      if (key && isMessageKey(key)) set(el, t(lang, key));
    }
  }
}
