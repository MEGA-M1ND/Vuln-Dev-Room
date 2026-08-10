import type { GovernedAction } from "@prisma/client";

/**
 * Provider seams for the parts of a real agent platform that V1 deliberately
 * does not implement.
 *
 * These exist as interfaces rather than TODO comments so the control plane is
 * written against the shape of the real thing from day one. Swapping the mock
 * executor for a live agent should be an implementation change behind these
 * boundaries, not a rewrite of the routes, policy engine, or audit trail.
 *
 * Nothing here is wired up in V1. Every method throws.
 */

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export type SandboxHandle = {
  id: string;
  workspacePath: string;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/**
 * Isolated execution environment for a run.
 *
 * FUTURE INTEGRATION POINT — Docker / E2B / Firecracker.
 *
 * V1 never executes anything: `MockAgentExecutor` simulates command output.
 * That is a deliberate scope boundary, not an oversight. A control plane that
 * shells out before its isolation story is finished is a remote code execution
 * service with a policy engine bolted to the side, and the policy engine would
 * be the least interesting part of the resulting incident.
 *
 * A real implementation must provide, at minimum:
 *  - a filesystem scoped to one run's checkout, destroyed on completion
 *  - no network egress during the agent phase (dependency install happens in a
 *    separate, network-enabled setup phase — see services/agent-runtime)
 *  - CPU/memory/wall-clock limits enforced by the runtime, not by the agent
 *  - no ambient credentials: the sandbox never sees a GitHub token
 */
export interface SandboxProvider {
  create(runId: string, repositoryUrl: string, ref: string): Promise<SandboxHandle>;
  readFile(handle: SandboxHandle, path: string): Promise<string>;
  writeFile(handle: SandboxHandle, path: string, content: string): Promise<void>;
  exec(handle: SandboxHandle, command: string): Promise<CommandResult>;
  diff(handle: SandboxHandle): Promise<string>;
  destroy(handle: SandboxHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export type CreatePullRequestInput = {
  owner: string;
  repo: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
};

export type PullRequestResult = {
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
  commitSha: string | null;
};

/**
 * GitHub access on behalf of an installation.
 *
 * FUTURE INTEGRATION POINT — GitHub App installation tokens.
 *
 * The token exchange (App JWT signed with the private key, traded for a
 * short-lived installation token) must happen server-side only. No token,
 * private key, or installation id may ever reach the browser: the frontend
 * asks this app to act on GitHub, and never talks to GitHub itself.
 *
 * Note the absence of a `merge` method. That is intentional and load-bearing —
 * AgentGuard proposes changes and never lands them, so there is no code path,
 * API route, or UI control anywhere in the product that can merge to a default
 * branch. Adding one would require adding it here first.
 */
export interface GitHubProvider {
  listRepositories(installationId: string): Promise<
    { owner: string; name: string; defaultBranch: string; private: boolean }[]
  >;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestResult>;
  getPullRequestDiff(owner: string, repo: string, number: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type PlanStep = {
  description: string;
  action: GovernedAction;
  path?: string;
  command?: string;
};

export type AgentPlan = {
  summary: string;
  steps: PlanStep[];
};

/**
 * The reasoning model behind a run.
 *
 * FUTURE INTEGRATION POINT — LangGraph orchestration over a model provider.
 *
 * The graph is expected to own tool-calling and checkpointing; this interface
 * is the narrow surface the control plane needs. Every tool call the graph
 * proposes must be routed through `enforceAction` before it executes — the
 * policy check belongs between the model's intent and the sandbox, not inside
 * the model's prompt, because a prompt is a request and a policy is a control.
 */
export interface LLMProvider {
  plan(taskDescription: string, repositoryContext: string): Promise<AgentPlan>;
  proposePatch(plan: AgentPlan, fileContents: Record<string, string>): Promise<string>;
}

// ---------------------------------------------------------------------------

const NOT_IMPLEMENTED =
  "Not implemented in V1. See src/lib/agents/providers.ts for the integration contract.";

/** Placeholder that fails loudly if something tries to use a real provider. */
export function unimplementedProvider<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      return () => {
        throw new Error(`${name}.${String(property)}: ${NOT_IMPLEMENTED}`);
      };
    },
  });
}
