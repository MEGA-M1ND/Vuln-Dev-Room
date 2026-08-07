import * as React from "react";

/** Consistent page title block. Keeps heading levels and spacing uniform. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border bg-background/60 px-8 py-6 backdrop-blur">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="ag-no-print flex shrink-0 items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}
