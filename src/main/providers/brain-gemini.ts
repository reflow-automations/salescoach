// Gemini text model via streamGenerateContent (server-sent events).
import { errorFrom, readSse, rejectsKnob, type Brain } from "./brain";

export interface GeminiBrainOptions {
  model: string;
  apiKey: string;
  /** Default true: thinkingLevel "minimal", so a live tip starts fast. False lets the model think as usual. */
  minimalThinking?: boolean;
  /** Default 200 (a short tip). */
  maxOutputTokens?: number;
  /** Default 0.4. */
  temperature?: number;
}

// Models that proved to reject thinkingLevel (Gemini 2.x). Module level, because
// main builds a fresh Brain for every tip; a per-Brain flag would be forgotten.
const knobRejected = new Set<string>();

export function createGeminiBrain(o: GeminiBrainOptions): Brain {
  return async ({ instructions, input, signal, onDelta }) => {
    const withKnob = o.minimalThinking !== false && !knobRejected.has(o.model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(o.model)}:streamGenerateContent?alt=sse`;
    const body = (withKnob: boolean) => {
      const generationConfig: Record<string, unknown> = { maxOutputTokens: o.maxOutputTokens ?? 200, temperature: o.temperature ?? 0.4 };
      if (withKnob) generationConfig.thinkingConfig = { thinkingLevel: "minimal" };
      return JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: "user", parts: [{ text: input }] }],
        generationConfig,
      });
    };
    const post = (withKnob: boolean) =>
      fetch(url, {
        method: "POST",
        signal,
        headers: { "x-goog-api-key": o.apiKey, "Content-Type": "application/json" },
        body: body(withKnob),
      });

    let res = await post(withKnob);
    // Only a 400 about the knob earns a retry; a bad key is also a 400 here.
    if (res.status === 400 && withKnob && (await rejectsKnob(res, /thinking/i))) {
      res = await post(false);
      // Remember only a proven rejection: the same request without the knob worked.
      if (res.ok) knobRejected.add(o.model);
    }
    if (!res.ok) throw await errorFrom(res, "Gemini");

    let text = "";
    for await (const data of readSse(res, signal)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      const parts = ev.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === "string" && !p.thought) {
          text += p.text;
          onDelta(p.text);
        }
      }
    }
    return text;
  };
}
