// "Brain": a fast text model that turns the conversation into one short tip.
// Both providers stream, so the first words show up quickly.

export interface BrainRequest {
  instructions: string;
  input: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

export type Brain = (req: BrainRequest) => Promise<string>;

export class BrainError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Reads a fetch Response body as server-sent events and yields each data payload. */
export async function* readSse(res: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * True when an error response complains about one of our optional speed knobs.
 * Reads a clone, so errorFrom can still read the original when it is not about them.
 */
export async function rejectsKnob(res: Response, knob: RegExp): Promise<boolean> {
  let text: string;
  try {
    text = await res.clone().text();
  } catch {
    return false;
  }
  if (!knob.test(text)) return false;
  // We retry without knobs, so free the first response's connection.
  await res.body?.cancel().catch(() => {});
  return true;
}

export async function errorFrom(res: Response, provider: string): Promise<BrainError> {
  let detail = "";
  let code: string | undefined;
  try {
    const body: any = await res.json();
    detail = body?.error?.message ?? JSON.stringify(body);
    code = body?.error?.code ?? body?.error?.status;
  } catch {
    detail = res.statusText;
  }
  return new BrainError(`${provider} ${res.status}: ${detail}`, res.status, code);
}
