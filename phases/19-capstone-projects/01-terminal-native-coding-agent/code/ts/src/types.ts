export type Status = "pending" | "in_progress" | "done" | "failed";

export type TodoItem = {
  id: number;
  description: string;
  status: Status;
  note: string;
};

export type HookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "PreCompact";

export type HookPayload = Record<string, unknown>;
export type HookFn = (payload: HookPayload) => HookPayload;

export type ToolArgs = Record<string, string>;
export type ToolFn = (sandbox: string, args: ToolArgs) => string;
export type ToolCall = { name: string; args: ToolArgs };

export type ToolOutcome = "success" | "error" | "blocked";

/** One finished tool call. Failures are included so the next turn can see them. */
export type ToolObservation = {
  name: string;
  args: ToolArgs;
  outcome: ToolOutcome;
  /** Tool text on success; the block reason or error message otherwise. */
  output: string;
};

export type ModelTurn = {
  plan: TodoItem[];
  tool: ToolCall | null;
  tokens: number;
  cost: number;
};

/** Task, plan, and prior tool results shown to the model at the start of a turn. */
export type ModelContext = {
  task: string;
  plan: readonly TodoItem[];
  observations: readonly ToolObservation[];
};

/** Offline or live model. `step` may return a turn directly or as a promise. */
export interface AgentModel {
  step(context: ModelContext): ModelTurn | Promise<ModelTurn>;
}

export type BudgetSnapshot = {
  turnsUsed: number;
  tokensUsed: number;
  dollarsUsed: number;
};

export type BudgetLimit = "turn_limit" | "token_limit" | "dollar_limit";
export type StopReason = BudgetLimit | "complete";
export type RunMode = "offline-demo" | "live";

export type RunResult = {
  plan: string;
  budget: BudgetSnapshot;
  trace: HookPayload[];
  /**
   * Offline demo: the scripted plan finished with every item done.
   * Live run: true only after a verified repair. A plan marked done is not proof.
   */
  passed: boolean;
  /** True only when a verifier has shown the repair, never from plan status alone. */
  verified: boolean;
  mode: RunMode;
  stopReason: StopReason;
};
