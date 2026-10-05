// Local storage in the Electron userData folder. Secrets are encrypted with
// safeStorage (DPAPI on Windows) and never leave the main process.
import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../shared/i18n";
import { DEFAULT_SETTINGS, EMPTY_PROFILE, type Profile, type SecretName, type Settings } from "../shared/types";

let language: () => string = () => "en";

/** Error texts follow this language; main passes the language of the settings. */
export function setLanguage(get: () => string): void {
  language = get;
}

function dir(): string {
  const d = app.getPath("userData");
  mkdirSync(d, { recursive: true });
  return d;
}

function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson<T>(name: string, fallback: T): T {
  const file = join(dir(), name);
  if (!existsSync(file)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(readFileSync(file, "utf-8")) };
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  writeAtomic(join(dir(), name), JSON.stringify(value, null, 2));
}

export function loadSettings(): Settings {
  return readJson("settings.json", DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings): void {
  writeJson("settings.json", s);
}

export function loadProfile(): Profile {
  return readJson("profile.json", EMPTY_PROFILE);
}

export function saveProfile(p: Profile): void {
  writeJson("profile.json", p);
}

export function loadCallBrief(): string {
  const file = join(dir(), "call-brief.md");
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

export function saveCallBrief(text: string): void {
  writeAtomic(join(dir(), "call-brief.md"), text);
}

// ---- encrypted blobs ----

function readEncrypted(name: string): string | null {
  const file = join(dir(), name);
  if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(readFileSync(file));
  } catch {
    return null;
  }
}

function writeEncrypted(name: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error(t(language(), "store.noEncryption"));
  writeAtomic(join(dir(), name), safeStorage.encryptString(value));
}

type Secrets = Partial<Record<SecretName, string>>;

function loadSecrets(): Secrets {
  const raw = readEncrypted("secrets.bin");
  return raw ? (JSON.parse(raw) as Secrets) : {};
}

export function getSecret(name: SecretName): string | undefined {
  return loadSecrets()[name] || undefined;
}

export function setSecret(name: SecretName, value: string): void {
  const s = loadSecrets();
  if (value) s[name] = value.trim();
  else delete s[name];
  writeEncrypted("secrets.bin", JSON.stringify(s));
}

export function hasSecrets(): Record<SecretName, boolean> {
  const s = loadSecrets();
  return { openaiKey: !!s.openaiKey, geminiKey: !!s.geminiKey };
}

export function loadEncryptedJson<T>(name: string): T | null {
  const raw = readEncrypted(name);
  return raw ? (JSON.parse(raw) as T) : null;
}

export function saveEncryptedJson(name: string, value: unknown | null): void {
  if (value === null) {
    writeAtomic(join(dir(), name), Buffer.alloc(0));
    return;
  }
  writeEncrypted(name, JSON.stringify(value));
}

export function loadPlainJson<T>(name: string, fallback: T): T {
  return readJson(name, fallback);
}

export function savePlainJson(name: string, value: unknown): void {
  writeJson(name, value);
}
