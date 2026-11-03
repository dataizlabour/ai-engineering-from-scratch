import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, runAgentAsync } from "../src/harness.ts";
import { runEval } from "../src/eval.ts";
import { HookBus, destructiveGuard } from "../src/hooks.ts";
import { Budget, PlanState } from "../src/plan.ts";
import { parseCommand } from "../src/repl.ts";
import { toolReadFile, toolRunShell } from "../src/tools.ts";
import type { AgentModel, ModelTurn, ToolObservation } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function copyObservations(items: readonly ToolObservation[]): ToolObservation[] {
  return items.map((item) => ({
    name: item.name,
    args: { ...item.args },
    outcome: item.outcome,
    output: item.output,
  }));
}

function doneTurn(tokens: number, cost: number): ModelTurn {
  return {
    plan: [{ id: 1, description: "fix", status: "done", note: "" }],
    tool: null,
    tokens,
    cost,
  };
}

test("runAgent: scripted task converges to all-done plan", () => {
  const r = runAgent("demo", here);
  assert.equal(r.passed, true);
  assert.equal(r.verified, false);
  assert.equal(r.mode, "offline-demo");
  assert.equal(r.stopReason, "complete");
  assert.ok(r.plan.includes("[x] 1."));
  assert.ok(r.plan.includes("[x] 3."));
  assert.equal(r.budget.turnsUsed >= 1, true);
  assert.equal(r.budget.dollarsUsed > 0, true);
});

test("runAgentAsync: next turn receives the previous tool output", async () => {
  const seen: ToolObservation[][] = [];
  const model: AgentModel = {
    async step(context) {
      seen.push(copyObservations(context.observations));
      if (context.observations.length === 0) {
        return {
          plan: [{ id: 1, description: "list files", status: "in_progress", note: "" }],
          tool: { name: "run_shell", args: { cmd: "ls" } },
          tokens: 10,
          cost: 0.01,
        };
      }
      return {
        plan: [{ id: 1, description: "list files", status: "done", note: "" }],
        tool: null,
        tokens: 10,
        cost: 0.01,
      };
    },
  };

  const result = await runAgentAsync("list files", here, model);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], []);
  assert.equal(seen[1].length, 1);
  assert.equal(seen[1][0].name, "run_shell");
  assert.deepEqual(seen[1][0].args, { cmd: "ls" });
  assert.equal(seen[1][0].outcome, "success");
  assert.equal(seen[1][0].output, toolRunShell(here, { cmd: "ls" }));
  assert.equal(result.mode, "live");
  assert.equal(result.stopReason, "complete");
});

test("runAgentAsync: blocked and error observations reach the model", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "p19-01-"));
  try {
    let expectedError = "";
    try {
      toolReadFile(dir, { path: "../../../etc/passwd" });
    } catch (err) {
      expectedError = (err as Error).message;
    }
    assert.notEqual(expectedError, "");

    const seen: ToolObservation[][] = [];
    const model: AgentModel = {
      step(context): ModelTurn {
        seen.push(copyObservations(context.observations));
        if (context.observations.length === 0) {
          return {
            plan: [],
            tool: { name: "run_shell", args: { cmd: "rm -rf /" } },
            tokens: 1,
            cost: 0,
          };
        }
        if (context.observations.length === 1) {
          return {
            plan: [],
            tool: { name: "read_file", args: { path: "../../../etc/passwd" } },
            tokens: 1,
            cost: 0,
          };
        }
        return { plan: [], tool: null, tokens: 1, cost: 0 };
      },
    };

    await runAgentAsync("probe tools", dir, model);

    assert.equal(seen[1].length, 1);
    assert.equal(seen[1][0].name, "run_shell");
    assert.deepEqual(seen[1][0].args, { cmd: "rm -rf /" });
    assert.equal(seen[1][0].outcome, "blocked");
    assert.match(seen[1][0].output, /destructive/);

    assert.equal(seen[2].length, 2);
    assert.equal(seen[2][1].name, "read_file");
    assert.deepEqual(seen[2][1].args, { path: "../../../etc/passwd" });
    assert.equal(seen[2][1].outcome, "error");
    assert.equal(seen[2][1].output, expectedError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgentAsync: a done plan is not a verified repair", async () => {
  const model: AgentModel = {
    step() {
      return {
        plan: [
          { id: 1, description: "locate target file", status: "done", note: "" },
          { id: 2, description: "read and diagnose", status: "done", note: "" },
          { id: 3, description: "apply fix and verify", status: "done", note: "" },
        ],
        tool: null,
        tokens: 10,
        cost: 0.01,
      };
    },
  };
  const result = await runAgentAsync("fix the bug", here, model);
  assert.match(result.plan, /\[x\] 1\./);
  assert.match(result.plan, /\[x\] 3\./);
  assert.equal(result.stopReason, "complete");
  assert.equal(result.mode, "live");
  assert.equal(result.verified, false);
  assert.equal(result.passed, false);
});

test("runAgentAsync: budget exhaustion cannot pass", async () => {
  const tokenLimited = await runAgentAsync("fix", here, { step: () => doneTurn(200_000, 0) });
  assert.match(tokenLimited.plan, /\[x\] 1\. fix/);
  assert.equal(tokenLimited.passed, false);
  assert.equal(tokenLimited.verified, false);
  assert.equal(tokenLimited.stopReason, "token_limit");
  const tokenStop = tokenLimited.trace.find((event) => event.event === "stop");
  assert.equal(tokenStop?.reason, "token_limit");

  const dollarLimited = await runAgentAsync("fix", here, { step: () => doneTurn(1, 5) });
  assert.match(dollarLimited.plan, /\[x\] 1\. fix/);
  assert.equal(dollarLimited.passed, false);
  assert.equal(dollarLimited.verified, false);
  assert.equal(dollarLimited.stopReason, "dollar_limit");
  const dollarStop = dollarLimited.trace.find((event) => event.event === "stop");
  assert.equal(dollarStop?.reason, "dollar_limit");
});

test("runEval: all three offline tasks pass", () => {
  const e = runEval(here);
  assert.equal(e.passed, 3);
  assert.equal(e.failed, 0);
});

test("HookBus: fires hooks in registration order", () => {
  const bus = new HookBus();
  const order: string[] = [];
  bus.on("PreToolUse", (p) => {
    order.push("a");
    return p;
  });
  bus.on("PreToolUse", (p) => {
    order.push("b");
    return p;
  });
  bus.fire("PreToolUse", { tool: "x" });
  assert.deepEqual(order, ["a", "b"]);
});

test("destructiveGuard: blocks rm -rf", () => {
  const out = destructiveGuard({ tool: "run_shell", args: { cmd: "rm -rf /" } });
  assert.equal(out.blocked, true);
  assert.match(String(out.reason), /destructive/);
});

test("destructiveGuard: passes safe commands", () => {
  const out = destructiveGuard({ tool: "run_shell", args: { cmd: "ls" } });
  assert.equal(out.blocked, undefined);
});

test("Budget: trips on turn limit", () => {
  const b = new Budget();
  b.maxTurns = 2;
  b.step(10, 0.01);
  assert.equal(b.exceeded(), null);
  b.step(10, 0.01);
  assert.equal(b.exceeded(), "turn_limit");
});

test("PlanState: summary marks status correctly", () => {
  const p = new PlanState("write");
  p.rewrite([
    { id: 1, description: "draft", status: "done", note: "" },
    { id: 2, description: "edit", status: "in_progress", note: "" },
  ]);
  const s = p.summary();
  assert.match(s, /\[x\] 1\. draft/);
  assert.match(s, /\[>\] 2\. edit/);
});

test("parseCommand: recognizes core verbs", () => {
  assert.equal(parseCommand("quit").kind, "quit");
  assert.equal(parseCommand("help").kind, "help");
  assert.equal(parseCommand("eval").kind, "eval");
  const run = parseCommand("run fix the bug");
  assert.equal(run.kind, "run");
  if (run.kind === "run") assert.equal(run.task, "fix the bug");
  assert.equal(parseCommand("teleport").kind, "unknown");
});
