"use client";

import * as React from "react";
import { useEventListener } from "@liveblocks/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type { BlastRadiusResult } from "@/contracts/blast-radius";
import { cn } from "@/lib/utils";

/**
 * "What would touching X affect?" — asked before a feature is discussed or an
 * agent is pointed at a task.
 *
 * The answer is stored server-side and broadcast as an id, so every participant
 * refetches and sees the *same* impact map. Rendering a locally-computed answer
 * per client would give two people in the same conversation two different
 * pictures, which is precisely the confusion this is meant to remove.
 */

/**
 * Bridges the room broadcast to a refetch. Split out because `useEventListener`
 * is only valid inside a Liveblocks RoomProvider; the panel itself must still
 * work when realtime is not configured.
 */
function BlastRadiusRealtime({ onSignal }: { onSignal: () => void }) {
  useEventListener(({ event }) => {
    if (event.type === "BLAST_RADIUS_UPDATED") onSignal();
  });
  return null;
}

type Mode = "description" | "path" | "symbol";

const MODE_LABEL: Record<Mode, string> = {
  description: "Describe it",
  path: "File path",
  symbol: "Symbol",
};

const MODE_PLACEHOLDER: Record<Mode, string> = {
  description: "the session expiry logic in auth",
  path: "src/lib/auth/session.ts",
  symbol: "SessionToken",
};

function depthTone(depth: number): string {
  if (depth === 0) return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (depth === 1) return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  return "bg-slate-500/15 text-slate-300 border-slate-500/30";
}

export function BlastRadiusPanel({
  roomId,
  realtimeEnabled = false,
}: {
  roomId: string;
  realtimeEnabled?: boolean;
}) {
  const [mode, setMode] = React.useState<Mode>("description");
  const [value, setValue] = React.useState("");
  const [result, setResult] = React.useState<BlastRadiusResult | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadLatest = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ results: BlastRadiusResult[] }>(
        `/api/blast-radius?roomId=${encodeURIComponent(roomId)}&limit=1`,
      );
      const latest = data.results[0];
      if (latest) setResult(latest);
    } catch {
      // A failed background refresh must not clobber a result already on
      // screen; the user's own query surfaces its errors explicitly below.
    }
  }, [roomId]);

  React.useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || pending) return;

    setPending(true);
    setError(null);
    try {
      const body: Record<string, string> = { roomId };
      if (mode === "description") body.description = trimmed;
      if (mode === "path") body.targetPath = trimmed;
      if (mode === "symbol") body.targetSymbol = trimmed;

      const data = await apiFetch<{ result: BlastRadiusResult }>(
        "/api/blast-radius",
        { method: "POST", body: JSON.stringify(body) },
      );
      setResult(data.result);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not compute the blast radius.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
      {realtimeEnabled ? <BlastRadiusRealtime onSignal={loadLatest} /> : null}

      <header className="mb-3">
        <h2 className="text-sm font-semibold text-slate-200">Blast radius</h2>
        <p className="text-xs text-slate-400">
          What would touching this affect? Answered from the repository, not from
          a doc.
        </p>
      </header>

      <div className="mb-2 flex gap-1">
        {(Object.keys(MODE_LABEL) as Mode[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            className={cn(
              "rounded px-2 py-1 text-xs transition",
              mode === option
                ? "bg-slate-700 text-slate-100"
                : "text-slate-400 hover:text-slate-200",
            )}
          >
            {MODE_LABEL[option]}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={MODE_PLACEHOLDER[mode]}
          aria-label={MODE_LABEL[mode]}
          className="flex-1 rounded border border-slate-800 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600"
        />
        <Button type="submit" disabled={pending || !value.trim()}>
          {pending ? "Analysing…" : "Analyse"}
        </Button>
      </form>

      {error ? (
        <p className="mt-2 text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {result ? <ResultCard result={result} /> : null}
    </section>
  );
}

function ResultCard({ result }: { result: BlastRadiusResult }) {
  const owners = React.useMemo(() => {
    const seen = new Map<string, { name: string; userId: string | null }>();
    for (const entry of result.owners) {
      for (const owner of entry.owners) {
        if (!seen.has(owner.email)) {
          seen.set(owner.email, { name: owner.name, userId: owner.userId });
        }
      }
    }
    return Array.from(seen.values()).slice(0, 5);
  }, [result.owners]);

  if (result.fileCount === 0) {
    return (
      <p className="mt-3 rounded border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-300">
        {result.summary}
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded border border-slate-800 bg-slate-900/60 p-3">
      <p className="text-sm text-slate-200">{result.summary}</p>

      <div className="flex flex-wrap gap-2 text-xs">
        <Badge>{result.fileCount} files reached</Badge>
        {result.contractsTouched.length > 0 ? (
          <Badge className="border-red-500/30 bg-red-500/15 text-red-300">
            {result.contractsTouched.length} critical path
            {result.contractsTouched.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {result.apiEndpointsTouched.length > 0 ? (
          <Badge className="border-violet-500/30 bg-violet-500/15 text-violet-300">
            {result.apiEndpointsTouched.length} API surface
          </Badge>
        ) : null}
        {result.truncated ? (
          <Badge className="border-amber-500/30 bg-amber-500/15 text-amber-300">
            Partial — bound reached
          </Badge>
        ) : null}
      </div>

      {result.apiEndpointsTouched.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs font-medium text-slate-400">
            API surface affected
          </h3>
          <ul className="flex flex-wrap gap-1">
            {result.apiEndpointsTouched.map((endpoint) => (
              <li
                key={endpoint}
                className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200"
              >
                {endpoint}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <h3 className="mb-1 text-xs font-medium text-slate-400">
          Files reached (nearest first)
        </h3>
        {/* Bounded height: a wide blast radius must not push the rest of the
            room off screen — the count above is the headline, the list is detail. */}
        <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
          {result.affectedFiles.map((file) => (
            <li
              key={file.path}
              className="flex items-center gap-2 font-mono text-[11px] text-slate-300"
            >
              <span
                className={cn(
                  "shrink-0 rounded border px-1",
                  depthTone(file.depth),
                )}
                title={
                  file.depth === 0
                    ? "The file you asked about"
                    : `${file.depth} import hop${file.depth === 1 ? "" : "s"} away`
                }
              >
                {file.depth === 0 ? "seed" : `+${file.depth}`}
              </span>
              <span className="truncate">{file.path}</span>
              {file.isCriticalPath ? (
                <span className="shrink-0 text-red-400" title="Critical path">
                  ●
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {owners.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs font-medium text-slate-400">
            Recently worked here
          </h3>
          <p className="text-xs text-slate-300">
            {owners.map((o) => o.name).join(", ")}
          </p>
        </div>
      ) : null}

      <p className="text-[11px] text-slate-500">
        Asked by {result.requestedBy.name ?? "a teammate"} ·{" "}
        {new Date(result.createdAt).toLocaleString()}
      </p>
    </div>
  );
}
