# Capstone 19/01 — Terminal-Native Coding Agent (TypeScript)

Multi-file TypeScript harness for the plan/act/observe loop described in
`../docs/en.md`. Offline, deterministic, zero network calls.

## Layout

```text
src/
  index.ts     entry point; runs a scripted demo and the eval, then exits 0
  repl.ts      interactive command parser (run / eval / help / quit)
  harness.ts   plan-act-observe loop: sync `runAgent`, async `runAgentAsync`
  hooks.ts     eight-event hook bus plus a destructive-command guard
  model.ts     scripted offline model (`AgentModel`) that drives the demo
  tools.ts     read_file + run_shell with zod-validated args
  plan.ts     PlanState (todo rewrite) + Budget (turn / token / dollar ceilings)
  eval.ts      tiny pass/fail counter across three offline tasks
  types.ts     shared shape definitions
tests/
  harness.test.ts
  tools.test.ts
```

## Run

```bash
npm install
npm start                # runs the scripted demo + offline eval, exits 0
npm start -- --repl      # opens the interactive harness REPL
npm test                 # node --test runner via tsx
npm run typecheck        # tsc --noEmit
```

The non-interactive `npm start` path asserts that the eval reports `passed=3
failed=0` and that the scripted run converges to an all-done plan. Any drift
fails the run.

`runAgent` stays synchronous and scripted. Its `passed` flag means that offline
demo finished with every plan item done. `runAgentAsync(task, sandbox, model)`
awaits a model that returns `ModelTurn` or `Promise<ModelTurn>` and feeds each
tool observation — success, error, or blocked — back on the next turn. A live
model marking the plan done does not set `passed` or `verified`. Stopping
because the budget is exhausted records `turn_limit`, `token_limit`, or
`dollar_limit`, and `passed` stays false.
