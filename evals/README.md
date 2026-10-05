# Evals: how good are the tips?

The unit tests (`npm test`) check the code. This eval checks the model: does a real excerpt from a sales call get a useful tip, and does the coach stay quiet during small talk?

The eval sends 30 excerpts from sales calls (B2B services) to the model, with the same instructions and the same input as the app. For each excerpt it measures the speed, runs a few automatic checks and writes everything to a report in which you fill in your verdict per tip.

There are two sets with the same 30 situations, the same categories and the same structure:

| `EVAL_LANG` | Cases | Example profile | Language of the tips |
| --- | --- | --- | --- |
| `en` (default) | `evals/cases.en.json`, natural spoken English | `examples/profile-example.en.md` (Sam Carter, fictional) | English |
| `nl` | `evals/cases.json`, Dutch | `examples/profile-example.nl.md` (Lisa de Vries, fictional) | Dutch |

## Running it

You need your own key. The eval only reads it from the environment, never from a file, and never writes it anywhere.

Gemini (the default), in PowerShell from the project folder:

```powershell
$env:GEMINI_API_KEY="your-key"
npm run eval
```

The Dutch set:

```powershell
$env:EVAL_LANG="nl"
npm run eval
```

OpenAI (only with an API key, not with a ChatGPT plan):

```powershell
$env:EVAL_PROVIDER="openai"
$env:OPENAI_API_KEY="your-key"
npm run eval
```

Without a key the eval stops with a message and exit code 1, without calling anything.

The key set this way only lives in this PowerShell window. Close the window and it is gone.

### Options

| Variable | What it does | Default |
| --- | --- | --- |
| `EVAL_LANG` | `en` or `nl`: picks the cases, the example profile and the language of the instructions | `en` |
| `EVAL_PROVIDER` | `gemini`, `openai`, or `dry` (a dry run with a fake answer, costs nothing, to check the report) | `gemini` |
| `EVAL_MODEL` | Try another model | the app's default model |
| `EVAL_PROFILE` | Path to a profile in the import format (the `## WHO_AM_I`, `## OFFER` and so on headings) | the example profile of `EVAL_LANG` |
| `EVAL_ONLY` | Only some cases, by id or category, comma separated: `price,buying-signal-1` | all |
| `EVAL_GAP_MS` | Pause between cases in milliseconds | `4000` |

If the profile file does not exist, the eval runs with an empty profile and says so. Tips about prices, cases and lead times then get more general, and that is exactly what you want to see: does the model make anything up?

The cases run one by one, with a pause in between, so you stay within the limits of a free Gemini key. If a case still gets a 429 (too many requests), the eval waits 20 seconds and tries once more. 30 cases take about three minutes this way.

## What the checks mean

| Check | Meaning |
| --- | --- |
| Answer without an error | The model answered within 30 seconds, without an error. |
| PASS right (auto) | Only for automatic tips. During small talk the model should answer `PASS` (the app then shows nothing); after an objection, buying signal or question it should give a tip. The report counts separately how often a tip was missed and how often a needless tip came. |
| Hotkey gives a tip | After the hotkey there must always be a tip, never empty and never `PASS`. |
| Line 1 at most 20 words | The first line must be readable at a glance. The instructions ask for 15 words; the check leaves some room. |
| At most 2 lines | A tip is two lines at most. |
| Line 2 starts with '? ' | A second line is always a question you can ask, and starts with a question mark and a space. |
| No em dash or en dash | The long dashes do not belong in the tips. |
| No 'Tip:' in front | No labels or markup in front of the tip. |

Checks that do not apply (for example the word count of a `PASS`) do not count toward the score.

The speed is at the top of the report: the median time to the first word (that is what you notice in a call) and the median total time.

## The report

Every run writes a new file to `evals/results/`, for example `eval-2026-10-04T14-05-12.345Z.md`. The summary is at the top, then for each case the excerpt, the tip, the checks, what a good tip would do, and an empty `Verdict:` line. You fill that in yourself: the checks only say whether the form is right, not whether the tip is good.

`evals/results/` is in `.gitignore`, so reports never end up in git, also when they contain part of your profile.

## Changing the cases

The excerpts are in `evals/cases.en.json` (English) and `evals/cases.json` (Dutch). Each case has:

- `id` and `category`
- `trigger`: `auto` (the coach decides by itself and may say `PASS`) or `hotkey` (you pressed the hotkey)
- `lines`: the call so far, with `speaker` `me` (you) or `them` (the customer)
- `expect`: one sentence on what a good tip does
- `shouldPass`: `true` when the coach should say nothing here

An `auto` case ends with a sentence from the customer of at least three words, because only then does the app ask for a tip by itself.

The two files describe the same situations in the same order, so results can be compared across languages. The English set uses English category names (for example `prijs` is `price`, `overleggen` is `check-with-others`).
