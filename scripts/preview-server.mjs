// Tiny static file server for dist-preview/ (no dependencies).
// Usage: node scripts/preview-server.mjs [port]   (default 5190), then open http://127.0.0.1:<port>/
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist-preview");
const port = Number(process.argv[2] ?? 5190);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Ongeldige poort: ${process.argv[2]}`);
  process.exit(1);
}
if (!existsSync(root)) {
  console.error("dist-preview/ bestaat nog niet. Draai eerst: node scripts/preview-build.mjs");
  process.exit(1);
}

const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  let file = normalize(join(root, pathname));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end(`Niet gevonden: ${pathname}`);
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `Poort ${port} is al in gebruik. Kies een andere: node scripts/preview-server.mjs ${port + 1}` : err);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`Salescoach preview: http://127.0.0.1:${port}/  (Ctrl+C om te stoppen)`));
