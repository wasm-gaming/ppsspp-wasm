# Fakes for the smoke runner

Seven modules shaped like the Emscripten glue — a default-exported factory returning a
promise for something with `callMain()` — each of which makes `tests/smoke.mjs` reach a
different verdict on purpose.

They exist because the runner's whole job is to say "no", and an instrument that cannot
fail is not an instrument. The previous session checked its verdicts against fakes like
these and then threw them away, so the next change to the runner had nothing to check
itself against. These are kept.

| Directory | What it does | Verdict | Exit |
| --- | --- | --- | --- |
| `draws/` | Paints eight coloured bands, and shifts them every frame. | `DRAWING` | 0 |
| `transparent/` | The same bands, cleared with alpha 0. | `DRAWING, BUT TRANSPARENT` | 1 |
| `clears/` | Owns a context and clears it to one colour, forever. | `CLEARED, NOT DRAWN` | 1 |
| `blank/` | Turns the event loop and never asks for a context. | `BLANK` | 1 |
| `offscreen/` | Clears into a framebuffer of its own, forever, and never blits. | `BLANK` | 1 |
| `blocks/` | Never returns from `callMain()`. | `BLOCKED` | 1 |
| `hangs/` | A factory promise that never settles. | `STOPPED at "instantiating"` | 1 |

`clears/` is the one that earns its keep. Every renderer clears its target, so a build
that comes up and draws nothing produces a perfectly uniform canvas — not an empty one.
A pixel test that only asked "is anything there?" would call that a pass.

`offscreen/` is the second. It and `blank/` reach the *same* verdict from opposite
causes — one renders busily into a framebuffer nobody sees, the other never renders at
all — and only the GL counters in the verdict's tail tell them apart. That pair is what
the counters exist for, and checking it here is what keeps them honest.

`transparent/` is the third, and it is a *pair* with `draws/` rather than a case on its
own: the two differ in one argument — the alpha they clear with — and in nothing else.
Both put colour on the screen; only the alpha-1 one can be read back by anything that
composites the canvas. That is the disagreement round 26 produced from the real
emulator, reproduced here in twelve seconds and with no emulator, and having both means
the verdict is separating the alpha channel from the browser, from SwiftShader and from
the sampler's own drawImage — all three of which are identical across the pair.

Run them with `make smoke-selftest`.
