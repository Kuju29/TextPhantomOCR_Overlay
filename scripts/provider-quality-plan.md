# Provider quality is a separate, paid release gate

This release does not run live trials and does not change production model,
Style, temperature, output contract or credit/name policy. Offline `npm test`
never makes these calls. No API key belongs in a fixture or result archive.

Before a live experiment, explicitly agree on a maximum call count, output-token
budget and charge budget, and identify the provider endpoint using the account's
actual supported catalogue. Stop before the remaining authorized budget cannot
cover the next call. Do not invent a price or endpoint slug, infer a free call
from missing usage, or continue automatically after 402/429/transport failure.

## Prepared experiment, not a claimed result

Use eight saved request bodies: failed dialogue, a single-unit foreign-script
leak, normal dialogue controls, and credit/name examples. Remove credentials
from stored inputs; inject a user-authorized credential only at execution.
Keep units, target language, System/Style, contract, thinking, output budget,
provider endpoint and starting workload profile constant. Trial A uses the
existing setting; trial B may test 0.2 versus the existing 0.7 *as a hypothesis*.
Alternate A/B order. Three repetitions (8 x 2 x 3 = 48 calls) are only screening,
not proof of general translation accuracy. Never attach a repair pass or silently
substitute a model to improve the apparent initial-pass score.

For each new provider generation record: fixture ID, requested/effective/observed
settings, generation ID, initial raw output, structural/script rejection,
independent human meaning/name/tone assessment, latency and reported usage.
Application replay is not a fresh provider trial. Unknown upstream fallback
history stays unknown. A credit that is intentionally preserved is assessed
against the agreed Style/glossary, not a hard-coded exception for a sample name.

If language accuracy does not improve, report that result before changing
another variable. Any winning configuration needs unseen/holdout requests,
normal dialogue controls, quality review and opt-in before a production change.

Status: NOT RUN. No spending budget or fresh provider authorization was supplied.
