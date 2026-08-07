import type { NextRequest } from "next/server";

import { requireRunPermission } from "@/lib/agent/run-access";
import { resumeStalledRun } from "@/lib/agents/driver";
import { handleRouteError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";

type Params = { params: Promise<{ runId: string }> };

/** Poll interval. Fast enough to feel live, slow enough not to hammer Postgres. */
const POLL_MS = 700;

/** Give up after this long so an abandoned tab cannot hold a connection forever. */
const MAX_STREAM_MS = 15 * 60 * 1000;

/**
 * GET /api/runs/[runId]/events/stream — Server-Sent Events for a run's timeline.
 *
 * Streams events strictly after the client's last seen sequence, so a reconnect
 * resumes rather than replaying (and never drops events in the gap, which a
 * timestamp-based cursor would).
 *
 * SSE rather than WebSockets on purpose: the data flows one way, and SSE
 * reconnects on its own through the browser's EventSource, which is most of
 * what a bidirectional transport would have bought here.
 *
 * The poll loop is a deliberate V1 choice over Postgres LISTEN/NOTIFY: it holds
 * no database session per viewer and survives connection-pool bouncers, which
 * NOTIFY does not. The cost is up to POLL_MS of latency.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { run } = await requireRunPermission(runId, "run:read");

    // A run left RUNNING by a server restart has nobody driving it; opening the
    // stream is the natural moment to pick it back up.
    resumeStalledRun(runId, run.status);

    const url = new URL(req.url);
    const lastEventId = req.headers.get("last-event-id");
    let cursor = Number.parseInt(
      lastEventId ?? url.searchParams.get("after") ?? "0",
      10,
    );
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

    const encoder = new TextEncoder();
    const startedAt = Date.now();

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;

        const send = (payload: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(payload));
          } catch {
            closed = true;
          }
        };

        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // Already torn down by the client disconnecting.
          }
        };

        req.signal.addEventListener("abort", close);

        // Tell the browser not to reconnect faster than the poll interval.
        send(`retry: ${POLL_MS * 2}\n\n`);

        let lastStatus = run.status;
        let lastVersion = run.runVersion;

        while (!closed) {
          if (Date.now() - startedAt > MAX_STREAM_MS) {
            send(`event: timeout\ndata: {"reason":"max-duration"}\n\n`);
            break;
          }

          const events = await prisma.runEvent.findMany({
            where: { runId, sequence: { gt: cursor } },
            orderBy: { sequence: "asc" },
            take: 100,
          });

          for (const event of events) {
            cursor = event.sequence;
            const data = JSON.stringify({
              id: event.id,
              sequence: event.sequence,
              type: event.type,
              actorType: event.actorType,
              actorId: event.actorId,
              payload: event.payloadJson,
              createdAt: event.createdAt.toISOString(),
              eventHash: event.eventHash,
            });
            // `id:` lets EventSource resume via Last-Event-ID after a drop.
            send(`id: ${event.sequence}\nevent: run-event\ndata: ${data}\n\n`);
          }

          const current = await prisma.agentRun.findUnique({
            where: { id: runId },
            select: { status: true, runVersion: true },
          });

          if (!current) {
            send(`event: gone\ndata: {}\n\n`);
            break;
          }

          if (
            current.status !== lastStatus ||
            current.runVersion !== lastVersion
          ) {
            lastStatus = current.status;
            lastVersion = current.runVersion;
            send(
              `event: run-status\ndata: ${JSON.stringify({
                status: current.status,
                runVersion: current.runVersion,
              })}\n\n`,
            );
          }

          const terminal = [
            "SUCCEEDED",
            "FAILED",
            "CANCELLED",
            "MERGED",
            "ABANDONED",
          ];
          if (terminal.includes(current.status)) {
            // Drain anything written between the event query and this check
            // before closing, so a terminal run never loses its last events.
            const trailing = await prisma.runEvent.findMany({
              where: { runId, sequence: { gt: cursor } },
              orderBy: { sequence: "asc" },
            });
            for (const event of trailing) {
              cursor = event.sequence;
              send(
                `id: ${event.sequence}\nevent: run-event\ndata: ${JSON.stringify({
                  id: event.id,
                  sequence: event.sequence,
                  type: event.type,
                  actorType: event.actorType,
                  actorId: event.actorId,
                  payload: event.payloadJson,
                  createdAt: event.createdAt.toISOString(),
                  eventHash: event.eventHash,
                })}\n\n`,
              );
            }
            send(`event: done\ndata: ${JSON.stringify({ status: current.status })}\n\n`);
            break;
          }

          // Comment frame doubles as a keep-alive through proxies that would
          // otherwise time out an idle connection.
          send(`: keep-alive\n\n`);
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }

        close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Nginx and friends buffer streamed responses unless told not to.
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
