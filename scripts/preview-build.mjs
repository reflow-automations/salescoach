// Builds a static preview of the renderer pages into dist-preview/, with a mock bridge
// (preview/mock-coach.ts) instead of Electron IPC, so designers can see the real UI in a browser.
//
// Usage: node scripts/preview-build.mjs [variant...]
//   current   = src/renderer
//   a, b, ... = design/<variant>/ (each of overlay.html, settings.html, style.css, overlay.ts and
//               settings.ts is taken from there when present, otherwise from src/renderer)
// Default: current, plus design/a and design/b when they exist.
// Serve the result with: node scripts/preview-server.mjs   (then open http://127.0.0.1:5190/)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRenderer = join(root, "src", "renderer");
const outRoot = join(root, "dist-preview");
const scenes = JSON.parse(readFileSync(join(root, "preview", "scenes.json"), "utf8"));
const PAGE_FILES = ["overlay.html", "settings.html", "style.css", "overlay.ts", "settings.ts"];
const RESERVED = new Set(["shots"]);

const common = { bundle: true, sourcemap: true, logLevel: "warning", loader: { ".md": "text" }, absWorkingDir: root };

const variantDir = (v) => (v === "current" ? srcRenderer : join(root, "design", v));
const isFile = (p) => existsSync(p) && statSync(p).isFile();

// ---------- which variants ----------

// Flags are for shots.cjs (npm run shots -- current --lang nl); the value after --lang is not a variant.
const argv = process.argv.slice(2);
let requested = argv.filter((a, i) => !a.startsWith("-") && argv[i - 1] !== "--lang");
if (!requested.length) requested = ["current", "a", "b"].filter((v) => v === "current" || existsSync(variantDir(v)));
const variants = [];
for (const v of requested) {
  if (!/^[a-z0-9_-]+$/i.test(v) || RESERVED.has(v)) {
    console.warn(`Overgeslagen: "${v}" is geen geldige variantnaam.`);
  } else if (!existsSync(variantDir(v))) {
    console.warn(`Overgeslagen: variant "${v}" bestaat niet (verwacht ${relative(root, variantDir(v)).replaceAll("\\", "/")}/).`);
  } else {
    variants.push(v);
  }
}

// ---------- helpers ----------

/** Finds the file an import path points at, the way esbuild would for these sources. */
function findModule(base) {
  for (const ext of ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"]) {
    if (isFile(base + ext)) return base + ext;
  }
  return null;
}

/**
 * Variant TS files import shared code relative to design/<v>/ (for example "../../src/renderer/capture").
 * As a convenience, a relative import that does not exist there is retried as if the file lived in
 * src/renderer, so "./capture" or "../shared/types" from a copied overlay.ts also work.
 */
function rendererFallback(dir) {
  return {
    name: "renderer-fallback",
    setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (!args.importer || relative(dir, args.importer).startsWith("..")) return undefined;
        if (findModule(resolve(dirname(args.importer), args.path))) return undefined;
        const sub = relative(dir, dirname(args.importer));
        const alt = findModule(resolve(srcRenderer, sub, args.path));
        return alt ? { path: alt } : undefined;
      });
    },
  };
}

/** Puts <script src="mock.js"> before the first script (or before </head>), so it runs first. */
function injectMock(html, label) {
  const headEnd = html.search(/<\/head>/i);
  const spots = [html.search(/<script\b/i), headEnd].filter((i) => i >= 0);
  if (!spots.length) throw new Error(`${label}: geen <script> of </head> gevonden om mock.js voor te zetten.`);
  const at = Math.min(...spots);
  const lineStart = html.lastIndexOf("\n", at - 1) + 1;
  const before = html.slice(lineStart, at);
  const indent = /^\s*$/.test(before) ? before : "";
  // Inside <head> the tag sits one indent level deeper than </head> itself.
  const extra = at === headEnd && indent ? "  " : "";
  return `${html.slice(0, at)}${extra}<script src="mock.js"></script>\n${indent}${html.slice(at)}`;
}

/** Same Inter files and fonts.css as scripts/build.mjs writes into dist/renderer. */
function copyInter(out) {
  const fontPkg = join(root, "node_modules", "@fontsource-variable", "inter");
  const fontCss = readFileSync(join(fontPkg, "wght.css"), "utf8");
  mkdirSync(join(out, "fonts"), { recursive: true });
  const faces = ["latin-ext", "latin"].map((subset) => {
    const file = `inter-${subset}-wght-normal.woff2`;
    cpSync(join(fontPkg, "files", file), join(out, "fonts", file));
    const range = fontCss.match(new RegExp(`inter-${subset}-wght-normal \\*/[^}]*unicode-range:\\s*([^;]+);`))?.[1];
    return [
      "@font-face {",
      '  font-family: "Inter Variable";',
      "  font-style: normal;",
      "  font-display: swap;",
      "  font-weight: 100 900;",
      `  src: url("fonts/${file}") format("woff2");`,
      ...(range ? [`  unicode-range: ${range.trim()};`] : []),
      "}",
    ].join("\n");
  });
  cpSync(join(fontPkg, "LICENSE"), join(out, "fonts", "LICENSE-Inter.txt"));
  writeFileSync(join(out, "fonts.css"), `/* Inter Variable, SIL Open Font License 1.1 (see fonts/LICENSE-Inter.txt). */\n${faces.join("\n\n")}\n`);
}

// ---------- build one variant ----------

async function buildVariant(v) {
  const dir = variantDir(v);
  const out = join(outRoot, v);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const own = (f) => dir !== srcRenderer && isFile(join(dir, f));
  const pick = (f) => (own(f) ? join(dir, f) : join(srcRenderer, f));

  // Extra assets a design brings along (images, icons, extra css). Copied first, so built files win.
  if (dir !== srcRenderer) {
    for (const name of readdirSync(dir)) {
      if (PAGE_FILES.includes(name) || /\.tsx?$/.test(name)) continue;
      cpSync(join(dir, name), join(out, name), { recursive: true, filter: (src) => !/\.tsx?$/.test(src) });
    }
  }

  await build({
    ...common,
    entryPoints: { overlay: pick("overlay.ts"), settings: pick("settings.ts") },
    outdir: out,
    platform: "browser",
    format: "esm",
    target: "chrome130",
    plugins: dir === srcRenderer ? [] : [rendererFallback(dir)],
  });
  await build({ ...common, entryPoints: [join(srcRenderer, "pcm-worklet.ts")], outfile: join(out, "pcm-worklet.js"), platform: "browser", format: "esm", target: "chrome130", sourcemap: false });
  await build({ ...common, entryPoints: [join(root, "preview", "mock-coach.ts")], outfile: join(out, "mock.js"), platform: "browser", format: "iife", target: "chrome130" });

  for (const page of ["overlay.html", "settings.html"]) {
    const html = readFileSync(pick(page), "utf8");
    writeFileSync(join(out, page), injectMock(html, relative(root, pick(page))));
  }
  cpSync(pick("style.css"), join(out, "style.css"));
  copyInter(out);

  const fromDesign = PAGE_FILES.filter(own);
  console.log(`${v}: dist-preview/${v}/  (${fromDesign.length ? `uit design/${v}: ${fromDesign.join(", ")}` : "alles uit src/renderer"})`);
}

// ---------- gallery ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function galleryHtml(list) {
  const { sizes } = scenes;
  const section = (title, page, sceneList, size, kind) => {
    const rows = sceneList
      .map((s) => {
        const cells = list
          .map((v) => {
            const url = `${v}/${page}.html?scene=${encodeURIComponent(s.name)}`;
            return `<figure>
          <figcaption><span class="variant">${esc(v)}</span><a href="${esc(url)}" target="_blank" rel="noopener">openen</a></figcaption>
          <iframe class="${kind}" src="${esc(url)}" width="${size.width}" height="${size.height}" loading="lazy" title="${esc(`${v} ${page} ${s.name}`)}"></iframe>
        </figure>`;
          })
          .join("\n        ");
        return `<div class="scene">
      <h3><code>${esc(s.name)}</code> ${esc(s.label)}</h3>
      <div class="row">
        ${cells}
      </div>
    </div>`;
      })
      .join("\n    ");
    return `<section>
    <h2>${esc(title)} <span class="dim">${size.width} x ${size.height}</span></h2>
    ${rows}
  </section>`;
  };

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Salescoach preview</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f3f4f6;
    --text: #1b1f24;
    --muted: #5f6b7a;
    --border: #d8dce2;
    --chip: #e6e9ee;
    --zoom: 1;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0e1013; --text: #e8eaee; --muted: #98a1ad; --border: #2a2f37; --chip: #1f232a; }
  }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 "Segoe UI", system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; padding: 14px 24px; background: var(--bg); border-bottom: 1px solid var(--border); }
  header h1 { margin: 0; font-size: 18px; }
  header p { margin: 0; color: var(--muted); }
  .zoom { display: flex; gap: 4px; margin-left: auto; }
  .zoom button { font: inherit; padding: 3px 10px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; }
  .zoom button[aria-pressed="true"] { background: var(--chip); font-weight: 600; }
  main { padding: 8px 24px 48px; }
  h2 { margin: 28px 0 4px; font-size: 16px; }
  h3 { margin: 18px 0 8px; font-size: 13px; font-weight: 500; color: var(--muted); }
  h3 code { color: var(--text); font-weight: 600; margin-right: 6px; }
  .dim { color: var(--muted); font-weight: 400; font-size: 13px; }
  .row { display: flex; gap: 24px; align-items: flex-start; overflow-x: auto; padding-bottom: 6px; }
  figure { margin: 0; flex: none; }
  figcaption { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 4px; font-size: 12px; color: var(--muted); }
  figcaption .variant { font-weight: 600; color: var(--text); text-transform: uppercase; letter-spacing: 0.04em; }
  figcaption a { color: inherit; }
  iframe { display: block; border: 1px solid var(--border); zoom: var(--zoom); }
  iframe.overlay { background: #131C2B; }
  iframe.settings { background: #ffffff; }
  @media (prefers-color-scheme: dark) { iframe.settings { background: #14161a; } }
</style>
</head>
<body>
<header>
  <h1>Salescoach preview</h1>
  <p>Echte renderer met nepdata (Lisa de Vries, Vries Webdesign). Knoppen werken tegen de mock. Kleuren volgen het thema van je systeem.</p>
  <div class="zoom" role="group" aria-label="Zoom">
    <button type="button" data-zoom="1">100%</button>
    <button type="button" data-zoom="0.75">75%</button>
    <button type="button" data-zoom="0.5">50%</button>
  </div>
</header>
<main>
  ${section("Overlay", "overlay", scenes.overlay, sizes.overlay, "overlay")}
  ${section("Overlay smal", "overlay", scenes.overlayNarrow, sizes.overlayNarrow, "overlay")}
  ${section("Instellingen", "settings", scenes.settings, sizes.settings, "settings")}
</main>
<script>
  (function () {
    var KEY = "salescoach.preview.zoom";
    function apply(z) {
      document.documentElement.style.setProperty("--zoom", z);
      document.querySelectorAll("[data-zoom]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.zoom === z)); });
      try { localStorage.setItem(KEY, z); } catch (e) {}
    }
    var start = "1";
    try { start = localStorage.getItem(KEY) || "1"; } catch (e) {}
    apply(start);
    document.querySelectorAll("[data-zoom]").forEach(function (b) { b.addEventListener("click", function () { apply(b.dataset.zoom); }); });
  })();
</script>
</body>
</html>
`;
}

// ---------- run ----------

mkdirSync(outRoot, { recursive: true });
for (const v of variants) await buildVariant(v);

// The gallery shows every variant that is built, also ones from an earlier run.
const built = readdirSync(outRoot)
  .filter((d) => isFile(join(outRoot, d, "overlay.html")))
  .sort((x, y) => (x === "current" ? -1 : y === "current" ? 1 : x.localeCompare(y)));
writeFileSync(join(outRoot, "index.html"), galleryHtml(built));
console.log(`Galerij: dist-preview/index.html (${built.join(", ") || "geen varianten"}). Bekijken: node scripts/preview-server.mjs`);
