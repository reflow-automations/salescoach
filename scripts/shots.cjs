// Screenshots of the preview pages (dist-preview/<variant>/) in hidden Electron windows.
//
// Usage: npx electron scripts/shots.cjs <variant> [--dark] [--scale=2] [--lang nl]
//   Build first: node scripts/preview-build.mjs <variant>   (or: npm run shots -- <variant>)
//   Light (default): every overlay scene at 560x210, overlay tip-done at 380x150 ("narrow"),
//                    every settings scene at 760x820, every feedback scene at 720x860.
//   --dark:          only the settings scenes, feedback done and overlay tip-done, with the OS theme forced to dark.
//   --scale=N:       device scale factor of the PNGs (default 1, so the PNG is exactly the window size).
//   --lang nl:       the pages in Dutch (also --lang=nl). Default English, which is also the app's default.
// Output: design/shots/<variant>/<page>-<scene>[-narrow][-dark][-nl].png  (English has no language suffix)
// Hard limit: the process quits after 90 s whatever happens.
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HARD_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 5_000;
const SETTLE_MS = 300;

const hardTimer = setTimeout(() => {
  console.error(`Harde limiet van ${HARD_TIMEOUT_MS / 1000} s bereikt, gestopt.`);
  app.exit(2);
}, HARD_TIMEOUT_MS);

const root = path.resolve(__dirname, "..");
const scenes = JSON.parse(fs.readFileSync(path.join(root, "preview", "scenes.json"), "utf8"));

// Everything after this script's own path; Chromium switches are ignored.
const scriptIndex = process.argv.findIndex((a) => /shots\.cjs$/i.test(a));
const args = process.argv.slice(scriptIndex + 1);
const dark = args.includes("--dark");
const scale = Number((args.find((a) => a.startsWith("--scale=")) ?? "--scale=1").split("=")[1]) || 1;
const langIndex = args.findIndex((a) => a === "--lang" || a.startsWith("--lang="));
const langArg = langIndex < 0 ? "en" : args[langIndex].includes("=") ? args[langIndex].split("=")[1] : args[langIndex + 1] ?? "en";
const lang = String(langArg).toLowerCase().startsWith("nl") ? "nl" : "en";
const langSuffix = lang === "en" ? "" : `-${lang}`;
const variant = args.find((a, i) => !a.startsWith("-") && !(langIndex >= 0 && i === langIndex + 1 && !args[langIndex].includes("="))) ?? "current";

const pageDir = path.join(root, "dist-preview", variant);
const outDir = path.join(root, "design", "shots", variant);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jobs() {
  const { sizes } = scenes;
  const suffix = `${dark ? "-dark" : ""}${langSuffix}`;
  const list = [];
  if (!dark) {
    for (const s of scenes.overlay) list.push({ page: "overlay", scene: s.name, size: sizes.overlay, file: `overlay-${s.name}${suffix}.png` });
    for (const s of scenes.overlayNarrow) list.push({ page: "overlay", scene: s.name, size: sizes.overlayNarrow, file: `overlay-${s.name}-narrow${suffix}.png` });
  } else {
    list.push({ page: "overlay", scene: "tip-done", size: sizes.overlay, file: `overlay-tip-done${suffix}.png` });
  }
  for (const s of scenes.settings) list.push({ page: "settings", scene: s.name, size: sizes.settings, file: `settings-${s.name}${suffix}.png` });
  for (const s of scenes.feedback) {
    if (dark && s.name !== "done") continue;
    list.push({ page: "feedback", scene: s.name, size: sizes.feedback, file: `feedback-${s.name}${suffix}.png` });
  }
  return list;
}

async function shoot(job) {
  const win = new BrowserWindow({
    show: false,
    width: job.size.width,
    height: job.size.height,
    useContentSize: true,
    frame: false,
    resizable: false,
    // Same as the real overlay window; the settings window keeps Electron's default.
    ...(job.page === "overlay" ? { backgroundColor: "#131C2B" } : {}),
    paintWhenInitiallyHidden: true,
    webPreferences: {
      // Offscreen rendering: a plain hidden window stops producing frames after the first
      // paints, so capturePage() returned a stale picture (for example "Starten..." while the
      // page already showed a tip). An offscreen window keeps painting while hidden.
      offscreen: { deviceScaleFactor: scale },
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const notes = [];
  win.webContents.on("console-message", (event, level, message) => {
    // Electron 35+ passes one details object; older versions pass (event, level, message).
    const lvl = typeof event?.level === "string" ? event.level : level;
    const msg = typeof event?.message === "string" ? event.message : message;
    if (lvl === "error" || lvl === "warning" || lvl === 3 || lvl === 2) notes.push(`${lvl}: ${msg}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => notes.push(`renderer weg: ${details.reason}`));

  try {
    await win.loadFile(path.join(pageDir, `${job.page}.html`), { query: { scene: job.scene, lang } });
    let ready = false;
    const until = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < until) {
      ready = await win.webContents.executeJavaScript("window.__sceneReady === true", true).catch(() => false);
      if (ready) break;
      await delay(100);
    }
    const sceneError = await win.webContents.executeJavaScript("window.__sceneError || ''", true).catch(() => "");
    // Ask for one more full frame, so the capture shows the final state.
    win.webContents.invalidate();
    await delay(SETTLE_MS);
    // The very first capture after start can fail while the compositor warms up; try again.
    let image = null;
    for (let attempt = 1; attempt <= 3 && !image; attempt++) {
      try {
        const shot = await win.webContents.capturePage();
        if (!shot.isEmpty()) image = shot;
      } catch (err) {
        if (attempt === 3) throw err;
      }
      if (!image) await delay(400);
    }
    if (!image) throw new Error("lege afbeelding");
    fs.writeFileSync(path.join(outDir, job.file), image.toPNG());
    const { width, height } = image.getSize();
    const problems = [...(ready ? [] : [`niet klaar binnen ${READY_TIMEOUT_MS / 1000} s`]), ...(sceneError ? [`scene: ${sceneError}`] : []), ...notes];
    console.log(`${problems.length ? "!!" : "ok"} ${job.file} (${width}x${height})${problems.map((p) => `\n     ${p}`).join("")}`);
    // Console warnings are reported but only a scene that never got ready counts as failed.
    return ready && !sceneError;
  } catch (err) {
    console.log(`!! ${job.file}: ${err.message}${notes.map((p) => `\n     ${p}`).join("")}`);
    return false;
  } finally {
    win.destroy();
  }
}

if (!fs.existsSync(path.join(pageDir, "overlay.html"))) {
  console.error(`dist-preview/${variant}/ bestaat niet. Draai eerst: node scripts/preview-build.mjs ${variant}`);
  process.exit(1);
}

// Keep shots apart from the real app's data. The PNG size is the window size times --scale
// (offscreen deviceScaleFactor), independent of the scaling of the real screen.
app.setPath("userData", path.join(os.tmpdir(), "salescoach-shots"));
app.disableHardwareAcceleration();
// Windows are opened one by one; closing the last one must not end the run.
app.on("window-all-closed", () => {});

app
  .whenReady()
  .then(async () => {
    nativeTheme.themeSource = dark ? "dark" : "light";
    fs.mkdirSync(outDir, { recursive: true });
    let failed = 0;
    for (const job of jobs()) if (!(await shoot(job))) failed++;
    console.log(`${failed ? `${failed} mislukt` : "Alles gelukt"}: design/shots/${variant}/`);
    clearTimeout(hardTimer);
    app.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
