import "server-only";

import { ApiError } from "@/lib/api/errors";
import { appendSessionEvent } from "@/lib/agent-coordination/events";
import { withIdempotency } from "@/lib/agent-coordination/idempotency";
import { requireMember, requireSessionInRoom } from "@/lib/agent-coordination/sessions";
import { scanAndRedactMany } from "@/lib/agent-coordination/redaction";
import type { PublishDiscoveryInput } from "@/contracts/agent-coordination";

/**
 * Publishing a discovery.
 *
 * A discovery is an agent's CLAIM, and this function's job is to record it
 * with enough provenance that a reader can weigh it — and to make sure it does
 * not carry a credential into the database on the way in.
 *
 * Nothing here can produce a VERIFIED discovery. The column defaults to
 * UNVERIFIED and this path never sets it: an agent able to mark its own
 * finding verified would make the distinction decorative, and "forged
 * validation claims" is an explicit threat in the model.
 */
export async function publishDiscovery(params: {
  roomId: string;
  principalUserId: string;
  input: PublishDiscoveryInput;
}): Promise<{
  discoveryId: string;
  status: "UNVERIFIED";
  redacted: boolean;
  currentSequence: number;
  replayed: boolean;
}> {
  const { input } = params;
  const session = await requireSessionInRoom({
    agentSessionId: input.session_id,
    roomId: params.roomId,
  });
  const member = await requireMember({
    agentSessionId: session.id,
    agentLabel: input.agent_label,
  });
  if (member.userId !== params.principalUserId) {
    throw new ApiError("FORBIDDEN", "That agent label belongs to a different principal.");
  }

  // Body and every evidence excerpt are scanned as ONE unit: accepting the
  // body while an excerpt still carried a key would defeat the control.
  const excerpts = input.evidence.map((e) => e.excerpt ?? null);
  const scan = scanAndRedactMany([input.content, ...excerpts]);
  if (!scan.ok) {
    throw new ApiError(
      "VALIDATION_ERROR",
      "This discovery looks like it contains a credential and was not stored. Reference the location of the finding instead of pasting the secret.",
      // Rule names only — `findings` never carries the matched text, so this
      // response cannot itself leak what it refused.
      { rules: scan.findings.map((f) => f.rule) },
    );
  }

  const [content, ...cleanedExcerpts] = scan.values;

  const { result, replayed } = await withIdempotency(
    {
      roomId: params.roomId,
      principalUserId: params.principalUserId,
      agentSessionId: session.id,
      toolName: "publish_discovery",
      idempotencyKey: input.idempotency_key,
    },
    async (tx) => {
      const discovery = await tx.discovery.create({
        data: {
          roomId: params.roomId,
          agentSessionId: session.id,
          authorMemberId: member.id,
          // Snapshot the provenance rather than relying on the member row,
          // so an old claim keeps the harness and model it was made with.
          harnessType: member.harnessType,
          model: member.model,
          type: input.type,
          title: input.title,
          content: content ?? "",
          confidence: input.confidence,
          affectedWorkUnitKeys: input.affected_work_unit_keys,
          baseCommitSha: input.base_commit_sha ?? session.baseCommitSha ?? null,
          redacted: scan.redacted,
          evidence: {
            create: input.evidence.map((e, i) => ({
              kind: e.kind,
              path: e.path ?? null,
              line: e.line ?? null,
              commitSha: e.commit_sha ?? null,
              url: e.url ?? null,
              excerpt: cleanedExcerpts[i] ?? null,
            })),
          },
        },
        select: { id: true },
      });

      const event = await appendSessionEvent(tx, {
        agentSessionId: session.id,
        roomId: params.roomId,
        type: "DISCOVERY_PUBLISHED",
        actorMemberId: member.id,
        entityId: discovery.id,
        // The event payload carries the headline, never the body: the log is
        // read by everyone in the room, and the body is the untrusted part.
        payload: {
          discoveryType: input.type,
          title: input.title,
          confidence: input.confidence,
          agentLabel: input.agent_label,
        },
      });

      return {
        discoveryId: discovery.id,
        status: "UNVERIFIED" as const,
        redacted: scan.redacted,
        currentSequence: event.sequence,
      };
    },
  );

  return { ...result, replayed };
}
