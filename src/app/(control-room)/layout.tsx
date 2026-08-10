import type { Metadata } from "next";

import { ShellNav } from "@/components/agentguard/shell";
import { isGitHubConfigured } from "@/env";
import { prisma } from "@/lib/db/client";
import { requireControlRoom, ROLE_LABEL } from "@/lib/dashboard/context";

export const metadata: Metadata = {
  title: "AgentGuard Control Room",
  description:
    "Governance and shared visibility for AI coding agents: policy, approval gates, and a tamper-evident audit trail.",
};

/**
 * Shell for every authenticated control-room page.
 *
 * Resolves the organization once here rather than in each page, so navigation
 * and the approvals badge stay consistent across routes.
 */
export default async function ControlRoomLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { organization, user, role } = await requireControlRoom();

  const pendingApprovals = await prisma.approvalRequest.count({
    where: { status: "PENDING", run: { roomId: organization.id } },
  });

  return (
    <div className="flex min-h-screen">
      <ShellNav
        organization={organization.name}
        userName={user.name ?? user.email ?? "Signed in"}
        roleLabel={ROLE_LABEL[role]}
        demoMode={!isGitHubConfigured}
        items={[
          { href: "/dashboard", label: "Dashboard" },
          { href: "/runs", label: "Runs" },
          { href: "/approvals", label: "Approvals", badge: pendingApprovals },
          { href: "/repositories", label: "Repositories" },
          { href: "/policies", label: "Policies" },
        ]}
      />
      <main className="ag-grid-backdrop min-w-0 flex-1 overflow-x-hidden">
        {children}
      </main>
    </div>
  );
}
