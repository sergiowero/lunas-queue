// The mark of an agent profile (docs/decisions/agent-profiles.md §Appearance): its icon in a chip of
// its color followed by its name. A Run without profile, or whose profile was deleted, shows a neutral
// chip with its agent kind; work that has no profile at all shows a "no profile" mark.
import type { AgentKind, AgentProfile, ProfileColor, ProfileIcon } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import type { Json } from "../lib/api.ts";
import { formatAgent } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { PROFILE_COLOR_CLASSES } from "../lib/profile-appearance.ts";
import { queries } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { NeutralGlyph, ProfileGlyph } from "./icons.tsx";

const CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset";
const NEUTRAL = "bg-surface-secondary text-text-secondary ring-border";

/**
 * Resolves profiles by id from the shared `agent-profiles` query. `find` answers null while the list
 * loads and for an id that no longer exists, so callers fall back to the neutral badge.
 */
export function useAgentProfiles() {
  const profiles = useQuery(queries.agentProfiles());
  const byId = new Map((profiles.data ?? []).map((profile) => [profile.id, profile]));
  return {
    find: (profileId: string | null | undefined): Json<AgentProfile> | null =>
      (profileId ? byId.get(profileId) : undefined) ?? null,
  };
}

/** The chip of an appearance; also the live preview of the profile form. */
export function ProfileChip({
  name,
  icon,
  color,
  className,
}: {
  name: string;
  icon: ProfileIcon;
  color: ProfileColor;
  className?: string | undefined;
}) {
  const t = useT();
  return (
    <span
      role="img"
      aria-label={t.agentBadge.label(name)}
      data-agent-badge="profile"
      data-icon={icon}
      data-color={color}
      className={cn(CHIP, PROFILE_COLOR_CLASSES[color], className)}
    >
      <ProfileGlyph icon={icon} />
      <span aria-hidden="true" className="truncate">
        {name}
      </span>
    </span>
  );
}

/**
 * Badge of the agent that did, or will do, a piece of work. With a known `profileId` it shows the
 * profile's appearance; otherwise it is neutral and shows `kind` (a Run's agent) or, without a kind,
 * that there is no profile.
 */
export function AgentBadge({
  profileId,
  kind,
  label,
  className,
}: {
  profileId: string | null | undefined;
  kind?: AgentKind | null | undefined;
  /** Text of the neutral badge instead of the bare kind (a Run shows «claude · opus»). */
  label?: string | undefined;
  className?: string | undefined;
}) {
  const t = useT();
  const profile = useAgentProfiles().find(profileId);
  if (profile) {
    return (
      <ProfileChip
        name={profile.name}
        icon={profile.icon}
        color={profile.color}
        className={className}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={kind ? t.agentBadge.neutralLabel(kind) : t.agentBadge.noProfileLabel}
      data-agent-badge="neutral"
      className={cn(CHIP, NEUTRAL, className)}
    >
      <NeutralGlyph />
      <span aria-hidden="true" className="truncate">
        {label ?? kind ?? t.agentBadge.noProfile}
      </span>
    </span>
  );
}

/**
 * The agent of a Run: the profile's badge followed by the provider and model it ran on
 * («claude · opus»); without a known profile, the neutral badge already carries that text.
 */
export function RunAgent({
  run,
}: {
  run: { profileId: string | null; agentKind: AgentKind; model?: string | null };
}) {
  const { find } = useAgentProfiles();
  const text = formatAgent(run);
  if (!find(run.profileId)) {
    return <AgentBadge profileId={null} kind={run.agentKind} label={text} />;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <AgentBadge profileId={run.profileId} kind={run.agentKind} />
      <span>{text}</span>
    </span>
  );
}
