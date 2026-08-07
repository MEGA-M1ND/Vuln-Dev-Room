"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { eventKind, eventLabel, type EventKind } from "@/lib/agent/vocabulary";
import { cn } from "@/lib/utils";

/**
 * Live run timeline, fed by Server-Sent Events.
 *
 * Seeded with the events already on the server so the timeline is complete on
 * first paint, then extended by the stream. The stream cursor starts at the
 * last seeded sequence, so nothing is duplicated and nothing in the gap is
 * skipped.
 */

export type TimelineEvent = {
  id: string;
  sequence: number;
  type: string;
  actorType: string;
  actorId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  eventHash: string | null;
};

const KIND_STYLE: Record<EventKind, { dot: string; text: string }> = {
  "policy-allow": { dot: "bg-allow", text: "text-allow" },
  "policy-deny": { dot: "bg-deny", text: "text-deny" },
  approval: { dot: "bg-gate", text: "text-gate" },
  agent: { dot: "bg-agent", text: "text-agent" },
  tool: { dot: "bg-tool", text: "text-tool" },
  test: { dot: "bg-tool", text: "text-tool" },
  delivery: { dot: "bg-allow", text: "text-allow" },
  lifecycle: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

const TERMINAL = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "MERGED",
  "ABANDONED",
]);

export function RunTimeline({
  runId,
  initialEvents,
  initialStatus,
}: {
  runId: string;
  initialEvents: TimelineEvent[];
  initialStatus: string;
}) {
  const router = useRouter();
  const [events, setEvents] = useState<TimelineEvent[]>(initialEvents);
  const [status, setStatus] = useState(initialStatus);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const shouldFollow = useRef(true);

  useEffect(() => {
    // A finished run has nothing left to stream; opening a connection to watch
    // it would hold a request open for fifteen minutes to deliver nothing.
    if (TERMINAL.has(status)) return;

    const after = events.length > 0 ? events[events.length - 1]!.sequence : 0;
    const source = new EventSource(
      `/api/runs/${runId}/events/stream?after=${after}`,
    );

    source.addEventListener("open", () => setConnected(true));

    source.addEventListener("run-event", (message) => {
      const event = JSON.parse((message as MessageEvent).data) as TimelineEvent;
      setEvents((current) =>
        // Guard against a reconnect replaying an event we already hold.
        current.some((e) => e.sequence === event.sequence)
          ? current
          : [...current, event],
      );
    });

    source.addEventListener("run-status", (message) => {
      const data = JSON.parse((message as MessageEvent).data) as {
        status: string;
      };
      setStatus(data.status);
      // Status drives the action buttons and the policy panel, which are
      // server-rendered; refresh so they reflect the new state.
      router.refresh();
    });

    source.addEventListener("done", () => {
      source.close();
      setConnected(false);
      router.refresh();
    });

    source.addEventListener("error", () => setConnected(false));

    return () => source.close();
    // `events` is deliberately excluded: it changes on every message, and
    // including it would tear down and rebuild the stream continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, status, router]);

  useEffect(() => {
    if (shouldFollow.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [events.length]);

  const live = !TERMINAL.has(status);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Activity timeline
        </h2>
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="ag-numeric">{events.length} events</span>
          {live && (
            <span
              className={cn(
                "flex items-center gap-1.5",
                connected ? "text-allow" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  connected ? "bg-allow" : "bg-muted-foreground",
                )}
                aria-hidden="true"
              />
              {connected ? "Live" : "Reconnecting…"}
            </span>
          )}
        </span>
      </div>

      <ol
        className="flex-1 overflow-y-auto px-5 py-4"
        // Announce new events without stealing focus from whatever the
        // reviewer is reading.
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(event) => {
          const el = event.currentTarget;
          shouldFollow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {events.length === 0 && (
          <li className="py-8 text-center text-xs text-muted-foreground">
            No events yet. Start the run to see the agent work.
          </li>
        )}

        {events.map((event, index) => {
          const kind = eventKind(event.type);
          const style = KIND_STYLE[kind];
          const payload = event.payload ?? {};
          const message =
            typeof payload.message === "string" ? payload.message : null;
          const reason =
            typeof payload.reason === "string" ? payload.reason : null;
          const policy =
            typeof payload.policy === "string" ? payload.policy : null;
          const path = typeof payload.path === "string" ? payload.path : null;
          const command =
            typeof payload.command === "string" ? payload.command : null;
          const comment =
            typeof payload.comment === "string" ? payload.comment : null;

          return (
            <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
              {/* Connector line between dots. */}
              {index < events.length - 1 && (
                <span
                  className="absolute left-[3px] top-3 h-full w-px bg-border"
                  aria-hidden="true"
                />
              )}
              <span
                className={cn(
                  "relative mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full",
                  style.dot,
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={cn("text-xs font-medium", style.text)}>
                    {eventLabel(event.type)}
                  </span>
                  <span className="ag-numeric text-[10px] text-muted-foreground">
                    #{event.sequence}
                  </span>
                  <time
                    className="ml-auto shrink-0 text-[10px] text-muted-foreground"
                    dateTime={event.createdAt}
                  >
                    {new Date(event.createdAt).toLocaleTimeString()}
                  </time>
                </div>

                {message && (
                  <p className="mt-0.5 text-[11px] leading-snug text-foreground/80">
                    {message}
                  </p>
                )}
                {reason && reason !== message && (
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {reason}
                  </p>
                )}
                {comment && (
                  <p className="mt-1 border-l-2 border-border pl-2 text-[11px] italic leading-snug text-muted-foreground">
                    “{comment}”
                  </p>
                )}
                {(path || command || policy) && (
                  <p className="mt-1 flex flex-wrap items-center gap-1.5">
                    {path && <Chip>{path}</Chip>}
                    {command && <Chip>{command}</Chip>}
                    {policy && (
                      <span className="text-[10px] text-muted-foreground">
                        rule: {policy}
                      </span>
                    )}
                  </p>
                )}
              </div>
            </li>
          );
        })}
        <div ref={bottomRef} />
      </ol>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
      {children}
    </code>
  );
}
