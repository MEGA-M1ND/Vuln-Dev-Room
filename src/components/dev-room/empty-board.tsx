"use client";

import { Button } from "@/components/ui/button";

export function EmptyBoard({
  canCreate,
  onCreate,
}: {
  canCreate: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
      <div className="rounded-full bg-muted p-4 text-2xl" aria-hidden="true">
        🗂️
      </div>
      <h3 className="mt-4 text-lg font-medium">No tickets yet</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {canCreate
          ? "Create the first ticket to start tracking work on the board."
          : "There are no tickets on this board yet."}
      </p>
      {canCreate ? (
        <Button className="mt-6" onClick={onCreate}>
          Create a ticket
        </Button>
      ) : null}
    </div>
  );
}
