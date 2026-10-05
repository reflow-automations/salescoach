// OpenAI Responses API with streaming. Works with an API key, or with a
// ChatGPT-plan OAuth access token (Sign in with ChatGPT). The plan flow requires
// store:false + stream:true and rejects sampling fields, so we keep the body minimal.
import { t } from "../../shared/i18n";
import { BrainError, errorFrom, readSse, rejectsKnob, type Brain } from "./brain";

const URL = "https://api.openai.com/v1/responses";

export interface OpenAIBrainOptions {
  model: string;
  getToken: () => Promise<string>;
  /** true when the token is a ChatGPT-plan OAuth token. */
  planUsage: boolean;
  /** Language of our own error texts ("en" or "nl"). Default English. */
  language?: string;
}

// Models that proved to reject the speed knobs. Module level, because main builds
// a fresh Brain for every tip; a per-Brain flag would pay the failed request each time.
const knobsRejected = new Set<string>();

export function createOpenAIBrain(o: OpenAIBrainOptions): Brain {
  return async ({ instructions, input, signal, onDelta }) => {
    const token = await o.getToken();
    const withKnobs = !knobsRejected.has(o.model);
    const body = (withKnobs: boolean) => {
      const b: Record<string, unknown> = {
        model: o.model,
        instructions,
        input: [{ role: "user", content: input }],
        stream: true,
        store: false,
      };
      if (withKnobs) {
        // Without these a ChatGPT model thinks for seconds before the first word.
        b.reasoning = { effort: o.planUsage ? "low" : "none" };
        b.text = { verbosity: "low" };
        // The plan flow rejects sampling fields such as max_output_tokens.
        if (!o.planUsage) b.max_output_tokens = 200;
      }
      return JSON.stringify(b);
    };

    const post = (knobs: boolean) =>
      fetch(URL, {
        method: "POST",
        signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body(knobs),
      });

    let res = await post(withKnobs);
    // Retry without knobs only when the 400 is about them; other 400s (bad model
    // name, oversized input) would just fail twice.
    if (res.status === 400 && withKnobs && (await rejectsKnob(res, /reasoning|effort|verbosity|max_output_tokens/i))) {
      res = await post(false);
      // Remember only a proven rejection: the same request without knobs worked.
      if (res.ok) knobsRejected.add(o.model);
    }
    if (!res.ok) throw await errorFrom(res, "OpenAI");

    let text = "";
    let completed = false;
    for await (const data of readSse(res, signal)) {
      if (data === "[DONE]") break;
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
        text += ev.delta;
        onDelta(ev.delta);
      } else if (ev.type === "response.completed") {
        completed = true;
      } else if (ev.type === "response.failed" || ev.type === "error") {
        const err = ev.response?.error ?? ev.error ?? {};
        throw new BrainError(`OpenAI: ${err.message ?? err.code ?? t(o.language, "brain.failed")}`, undefined, err.code);
      } else if (ev.type === "response.incomplete") {
        completed = true; // hit the token cap: keep what we have
      }
    }
    if (!completed && !signal.aborted) throw new BrainError(t(o.language, "brain.streamStopped"));
    return text;
  };
}
