"use client";

import * as React from "react";
import { useThreads, useCreateThread } from "@liveblocks/react";
import { Composer, Thread } from "@liveblocks/react-ui";
import "@liveblocks/react-ui/styles.css";

/**
 * Realtime ticket discussion powered by Liveblocks Threads. Each ticket's
 * comments are the threads whose metadata.ticketId matches. New top-level
 * comments create a new thread tagged with this ticket; replies and typing
 * indicators are handled by the Liveblocks <Thread> / <Composer> components.
 *
 * Only rendered when Liveblocks is configured (inside a RoomProvider).
 */
export function TicketComments({ ticketId }: { ticketId: string }) {
  const { threads, isLoading, error } = useThreads({
    query: { metadata: { ticketId } },
  });
  const createThread = useCreateThread();

  if (isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading discussion…
      </p>
    );
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not load the discussion.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No comments yet. Start the discussion below.
        </p>
      ) : (
        <ul className="space-y-3">
          {threads.map((thread) => (
            <li key={thread.id}>
              <Thread
                thread={thread}
                className="rounded-md border border-border bg-background"
              />
            </li>
          ))}
        </ul>
      )}

      <Composer
        onComposerSubmit={({ body }, event) => {
          event.preventDefault();
          createThread({ body, metadata: { ticketId } });
        }}
        className="rounded-md border border-border bg-background"
      />
    </div>
  );
}
