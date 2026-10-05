// Starts the real app with SALESCOACH_SMOKE=1 in a throwaway profile folder; exits with its code.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";

const userData = mkdtempSync(join(tmpdir(), "salescoach-smoke-"));
const child = spawn(electron, [".", `--user-data-dir=${userData}`], { stdio: "inherit", env: { ...process.env, SALESCOACH_SMOKE: "1" } });
const timer = setTimeout(() => {
  console.log("SMOKE FAIL: timeout");
  child.kill();
  process.exit(1);
}, 60000);
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});
