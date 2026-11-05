import { Budget, PlanState } from "./plan.ts";
import { HookBus, destructiveGuard } from "./hooks.ts";
import { ScriptedModel } from "./model.ts";
import { TOOLS } from "./tools.ts";
import type {
  AgentModel,
  HookPayload,
  ModelContext,
  ModelTurn,
  RunMode,
  RunResult,
  StopReason,
  ToolArgs,
  ToolObservation,
  ToolOutcome,
} from "./types.ts";

type Session = {
  task: string;
  sandbox: string;
  plan: PlanState;
  budget: Budget;
  hooks: HookBus;
  trace: HookPayload[];
  observations: ToolObservation[];
  turn: number;
  stopReason: StopReason | null;
};

function createSession(task: string, sandbox: string): Session {
  const plan = new PlanState(task);
  const budget = new Budget();
  const hooks = new HookBus();
  const trace: HookPayload[] = [];
  const session: Session = {
    task,
    sandbox,
    plan,
    budget,
    hooks,
    trace,
    observations: [],
    turn: 0,
    stopReason: null,
  };

  hooks.on("PreToolUse", destructiveGuard);
  hooks.on("PostToolUse", (p) => {
    trace.push({ event: "tool", ...p });
    return p;
  });
  hooks.on("SessionStart", (p) => {
    trace.push({ event: "start", ...p });
    return p;
  });
  hooks.on("SessionEnd", (p) => {
    trace.push({ event: "end", ...p });
    return p;
  });
  hooks.on("Stop", (p) => {
    trace.push({ event: "stop", ...p });
    return p;
  });

  hooks.fire("SessionStart", { task, sandbox, startedAt: Date.now() });
  return session;
}

function modelContext(session: Session): ModelContext {
  return {
    task: session.task,
    plan: session.plan.items.map((item) => ({ ...item })),
    observations: session.observations.map((item) => ({
      name: item.name,
      args: { ...item.args },
      outcome: item.outcome,
      output: item.output,
    })),
  };
}

function remember(
  name: string,
  args: ToolArgs,
  outcome: ToolOutcome,
  output: string,
): ToolObservation {
  return { name, args: { ...args }, outcome, output };
}

function halt(session: Session, reason: StopReason): void {
  session.stopReason = reason;
  session.hooks.fire("Stop", { reason, turn: session.turn });
}

function stopIfOverBudget(session: Session): boolean {
  const limit = session.budget.exceeded();
  if (!limit) return false;
  halt(session, limit);
  return true;
}

function consumeTurn(session: Session, step: ModelTurn): "continue" | "stop" {
  session.plan.rewrite(step.plan);
  session.budget.step(step.tokens, step.cost);
  if (stopIfOverBudget(session)) return "stop";

  if (step.tool === null) {
    halt(session, "complete");
    return "stop";
  }

  const { name, args } = step.tool;
  const pre = session.hooks.fire("PreToolUse", { tool: name, args });
  if (pre.blocked) {
    const reason = String(pre.reason ?? "");
    session.hooks.fire("PostToolUse", { tool: name, blocked: true, reason });
    session.observations.push(remember(name, args, "blocked", reason));
    session.turn += 1;
    return "continue";
  }

  try {
    const result = TOOLS[name](session.sandbox, args);
    session.hooks.fire("PostToolUse", { tool: name, ok: true, bytes: result.length });
    session.observations.push(remember(name, args, "success", result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    session.hooks.fire("PostToolUse", { tool: name, ok: false, error: message });
    session.observations.push(remember(name, args, "error", message));
  }
  session.turn += 1;
  return "continue";
}

function finish(session: Session, mode: RunMode): RunResult {
  const stopReason = session.stopReason;
  if (stopReason === null) {
    throw new Error("agent loop stopped without a reason");
  }
  session.hooks.fire("SessionEnd", session.budget.snapshot() as unknown as HookPayload);

  const allDone =
    session.plan.items.length > 0 && session.plan.items.every((item) => item.status === "done");
  // Scripted demo success is a finished all-done plan. A live model marking
  // items done is not evidence that the code was fixed or that tests passed.
  const verified = false;
  const demoPassed = mode === "offline-demo" && stopReason === "complete" && allDone;

  return {
    plan: session.plan.summary(),
    budget: session.budget.snapshot(),
    trace: session.trace,
    passed: mode === "offline-demo" ? demoPassed : verified,
    verified,
    mode,
    stopReason,
  };
}

export function runAgent(task: string, sandbox: string): RunResult {
  const session = createSession(task, sandbox);
  const model = new ScriptedModel();
  while (true) {
    if (stopIfOverBudget(session)) break;
    const step = model.step(modelContext(session));
    if (consumeTurn(session, step) === "stop") break;
  }
  return finish(session, "offline-demo");
}

export async function runAgentAsync(
  task: string,
  sandbox: string,
  model: AgentModel,
): Promise<RunResult> {
  const session = createSession(task, sandbox);
  while (true) {
    if (stopIfOverBudget(session)) break;
    const step = await model.step(modelContext(session));
    if (consumeTurn(session, step) === "stop") break;
  }
  return finish(session, "live");
}
