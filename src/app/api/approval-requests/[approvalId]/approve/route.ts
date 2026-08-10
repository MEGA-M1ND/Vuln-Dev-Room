import type { NextRequest } from "next/server";

import { handleApprovalDecision } from "@/lib/agents/approval-routes";

type Params = { params: Promise<{ approvalId: string }> };

/** POST /api/approval-requests/[approvalId]/approve */
export async function POST(req: NextRequest, { params }: Params) {
  const { approvalId } = await params;
  return handleApprovalDecision(req, approvalId, "APPROVE");
}
