"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * Persistent navigation for the control room.
 *
 * A client component only because it needs `usePathname` to mark the active
 * item. Everything it renders is passed in from the server layout, so no
 * organization or user data is fetched here.
 */

type NavItem = {
  href: string;
  label: string;
  /** Badge count, e.g. pending approvals. Zero renders nothing. */
  badge?: number;
};

export function ShellNav({
  items,
  organization,
  userName,
  roleLabel,
  demoMode,
}: {
  items: NavItem[];
  organization: string;
  userName: string;
  roleLabel: string;
  demoMode: boolean;
}) {
  const pathname = usePathname();

  return (
    <aside className="ag-no-print flex w-60 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
        <ShieldMark />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">
            AgentGuard
          </p>
          <p className="truncate text-[11px] leading-tight text-muted-foreground">
            Control Room
          </p>
        </div>
      </div>

      <div className="border-b border-border px-5 py-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Organization
        </p>
        <p className="mt-0.5 truncate text-xs font-medium">{organization}</p>
      </div>

      <nav className="flex-1 space-y-0.5 p-3" aria-label="Primary">
        {items.map((item) => {
          // Exact match for the dashboard root; prefix match elsewhere so a
          // run detail page keeps "Runs" highlighted.
          const active =
            item.href === "/dashboard"
              ? pathname === item.href
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center justify-between rounded-md px-3 py-2 text-xs font-medium transition-colors",
                active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <span>{item.label}</span>
              {item.badge ? (
                <span className="ag-numeric ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-gate/15 px-1.5 py-0.5 text-[10px] font-semibold text-gate">
                  {item.badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      {demoMode && (
        <div className="mx-3 mb-3 rounded-md border border-gate/30 bg-gate/10 px-3 py-2">
          <p className="text-[11px] font-semibold text-gate">Demo Mode</p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            No GitHub credentials configured. Repositories are seeded and agent
            execution is simulated.
          </p>
        </div>
      )}

      <div className="border-t border-border px-5 py-3">
        <p className="truncate text-xs font-medium">{userName}</p>
        <p className="text-[11px] text-muted-foreground">{roleLabel}</p>
      </div>
    </aside>
  );
}

function ShieldMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-7 w-7 shrink-0 text-agent"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8.9 7.5 10 4.3-1.1 7.5-5.4 7.5-10v-6L12 2.5Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
