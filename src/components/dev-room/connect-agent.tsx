"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";

/**
 * "Connect your own agent" — the bridge between a task on the board and a
 * coding agent running on someone's machine.
 *
 * This exists because the adapter needs a task id and, until this panel, there
 * was no way to get one without querying the database. A documented integration
 * whose first step is "run a SQL query" is not actually usable, so the setup
 * block is generated here, ready to paste.
 *
 * The ingestion token is deliberately NOT rendered. It is a server-side secret
 * that would otherwise be shipped to every browser that opens a task — the
 * snippet names the variable and leaves the value to the person running the
 * agent.
 */
export function ConnectAgent({ taskId }: { taskId: string }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);

  // Read at render time: on the server this is unknowable, and hardcoding a
  // guess would hand people a snippet pointing at the wrong host.
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const snippet = [
    `export DEVROOM_URL=${origin}`,
    `export DEVROOM_TASK_ID=${taskId}`,
    `export DEVROOM_INGEST_TOKEN=…   # ask whoever runs this server`,
  ].join("\n");

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2_000);
    } catch {
      // Clipboard access can be denied; the text is on screen to select.
      setCopied("failed");
      setTimeout(() => setCopied(null), 2_000);
    }
  }

  if (!open) {
    return (
      <div className="mt-3">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Connect your own agent…
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">Connect your own agent</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Point Claude Code (or any adapter) at this task and its session will
            show up here and in the control room.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Task ID
          </span>
          <Button variant="outline" size="sm" onClick={() => copy(taskId, "id")}>
            {copied === "id" ? "Copied" : "Copy"}
          </Button>
        </div>
        <code className="mt-1 block break-all rounded border border-border bg-background px-2 py-1 text-xs">
          {taskId}
        </code>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Run this in the shell you start your agent from
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => copy(snippet, "env")}
          >
            {copied === "env" ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre className="mt-1 overflow-x-auto rounded border border-border bg-background px-2 py-1 text-xs">
          {snippet}
        </pre>
      </div>

      {copied === "failed" ? (
        <p role="alert" className="mt-2 text-xs text-amber-700">
          Could not reach the clipboard — select the text above instead.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-muted-foreground">
        The token is a server secret and is deliberately not shown here. For
        Claude Code, also add the hooks block from{" "}
        <code>adapters/claude-code/settings.example.json</code> — see that
        folder&apos;s README.
      </p>
    </div>
  );
}
