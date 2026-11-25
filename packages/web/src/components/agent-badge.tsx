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
 * Resolves profiles by id from the shared `agent-profiles` query. `find` answers null for an id that
 * no longer exists, so callers fall back to the neutral badge. While the list loads (`loading`) or
 * when its query failed (`failed`), a profiled piece of work shows a placeholder or an «unavailable»
 * mark instead of a neutral badge that would claim there is no profile.
 */
export function useAgentProfiles() {
  // retryOnMount off: every badge is an observer, and each one mounting on a failed query would
  // refetch it again (a request storm while the server is failing). The list still refreshes on events.
  const profiles = useQuery({ ...queries.agentProfiles(), retryOnMount: false });
  const byId = new Map((profiles.data ?? []).map((profile) => [profile.id, profile]));
  return {
    loading: profiles.isPending,
    failed: profiles.isError,
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
  pending,
  unavailable,
  className,
}: {
  profileId: string | null | undefined;
  kind?: AgentKind | null | undefined;
  /** The work this badge belongs to is still loading (its Run): a placeholder, not a neutral badge. */
  pending?: boolean | undefined;
  /** The work this badge belongs to could not be loaded (its Run): neither a profile nor «no profile» is known. */
  unavailable?: boolean | undefined;
  /** Text of the neutral badge instead of the bare kind (a Run shows «claude · opus»). */
  label?: string | undefined;
  className?: string | undefined;
}) {
  const t = useT();
  const { find, loading, failed } = useAgentProfiles();
  const profile = find(profileId);
  // A profiled piece of work whose profile list has not arrived yet must not look unprofiled.
  if (pending || (loading && profileId)) {
    return (
      <span
        role="img"
        aria-label={t.common.loading}
        data-agent-badge="loading"
        className={cn(CHIP, NEUTRAL, className)}
      >
        <span aria-hidden="true">…</span>
      </span>
    );
  }
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
  // The profile is not known because something failed to load: do not claim there is none.
  if (unavailable || (failed && profileId)) {
    return (
      <span
        role="img"
        aria-label={t.agentBadge.unavailableLabel}
        data-agent-badge="unavailable"
        className={cn(CHIP, NEUTRAL, className)}
      >
        <span aria-hidden="true">—</span>
      </span>
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
  const { find, loading, failed } = useAgentProfiles();
  const text = formatAgent(run);
  if (loading && run.profileId) return <AgentBadge profileId={run.profileId} />;
  if (failed && run.profileId) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <AgentBadge profileId={run.profileId} />
        <span>{text}</span>
      </span>
    );
  }
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
