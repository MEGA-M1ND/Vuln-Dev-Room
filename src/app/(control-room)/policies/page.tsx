import { PageHeader } from "@/components/agentguard/page-header";
import { PolicySimulator } from "@/components/agentguard/policy-simulator";
import {
  Card,
  CardHeader,
  EFFECT_TONE,
  Pill,
  RiskPill,
} from "@/components/agentguard/primitives";
import { requireControlRoom } from "@/lib/dashboard/context";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

const EFFECT_LABEL = {
  ALLOW: "Allow",
  REQUIRE_APPROVAL: "Require approval",
  DENY: "Deny",
} as const;

export default async function PoliciesPage() {
  const { organization } = await requireControlRoom();

  const [profiles, policies, repositories] = await Promise.all([
    prisma.policyProfile.findMany({
      where: { OR: [{ roomId: null }, { roomId: organization.id }] },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      include: { _count: { select: { policies: true, runs: true } } },
    }),
    prisma.policy.findMany({
      where: { OR: [{ roomId: null }, { roomId: organization.id }] },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      include: {
        profile: { select: { name: true } },
        _count: { select: { decisions: true } },
      },
    }),
    prisma.repositoryConnection.findMany({
      where: { roomId: organization.id },
      select: { owner: true, repo: true },
      orderBy: { repo: "asc" },
    }),
  ]);

  const globalPolicies = policies.filter((p) => !p.policyProfileId);
  const profilePolicies = policies.filter((p) => p.policyProfileId);

  return (
    <>
      <PageHeader
        title="Policies"
        description="What agents in this organization may attempt. Any DENY beats any approval gate, which beats any allow — so a profile can tighten the rules but never loosen a global one."
      />

      <div className="grid gap-6 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Global rules"
              description="Applied to every run in every organization, regardless of profile."
            />
            <ul className="divide-y divide-border">
              {globalPolicies.map((policy) => (
                <PolicyRow key={policy.id} policy={policy} />
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Profile rules"
              description="Additional restrictions applied when a run selects that profile."
            />
            <ul className="divide-y divide-border">
              {profilePolicies.map((policy) => (
                <PolicyRow key={policy.id} policy={policy} showProfile />
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-6 xl:sticky xl:top-6 xl:self-start">
          <Card>
            <CardHeader title="Profiles" />
            <ul className="divide-y divide-border">
              {profiles.map((profile) => (
                <li key={profile.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium">{profile.name}</p>
                    {profile.isDefault && (
                      <Pill className="border-agent/40 bg-agent/10 text-agent">
                        default
                      </Pill>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                    {profile.description}
                  </p>
                  <p className="ag-numeric mt-1.5 text-[10px] text-muted-foreground">
                    {profile._count.policies} extra rule
                    {profile._count.policies === 1 ? "" : "s"} ·{" "}
                    {profile._count.runs} run
                    {profile._count.runs === 1 ? "" : "s"}
                  </p>
                </li>
              ))}
            </ul>
          </Card>

          <PolicySimulator
            roomId={organization.id}
            repositories={repositories.map((r) => `${r.owner}/${r.repo}`)}
          />
        </div>
      </div>
    </>
  );
}

type PolicyWithMeta = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  effect: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  message: string;
  priority: number;
  profile: { name: string } | null;
  _count: { decisions: number };
};

function PolicyRow({
  policy,
  showProfile = false,
}: {
  policy: PolicyWithMeta;
  showProfile?: boolean;
}) {
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-xs font-medium">
            {policy.name}
            {!policy.enabled && (
              <Pill className="border-border text-muted-foreground">
                disabled
              </Pill>
            )}
            {showProfile && policy.profile && (
              <span className="text-[11px] font-normal text-muted-foreground">
                {policy.profile.name}
              </span>
            )}
          </p>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
            {policy.description}
          </p>
          <p className="mt-1.5 text-[11px] italic text-foreground/70">
            “{policy.message}”
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RiskPill level={policy.riskLevel} />
          <Pill className={EFFECT_TONE[policy.effect]}>
            {EFFECT_LABEL[policy.effect]}
          </Pill>
        </div>
      </div>
      <p className="ag-numeric mt-2 text-[10px] text-muted-foreground">
        priority {policy.priority} · {policy._count.decisions} decision
        {policy._count.decisions === 1 ? "" : "s"} recorded
      </p>
    </li>
  );
}
