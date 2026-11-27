// Profiles tab: the global agent profiles (docs/decisions/agent-profiles.md). Each one is an ordered
// list of models; a model whose provider is disabled in Settings is skipped and shown as disabled.
import type { AgentProfile } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ProfileChip } from "../components/agent-badge.tsx";
import { PlusIcon } from "../components/icons.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { ProfileDeleteDialog } from "../components/profile-delete-dialog.tsx";
import { ProfileFormDialog } from "../components/profile-form-dialog.tsx";
import { EmptyState, Loading, QueryError } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { Json } from "../lib/api.ts";
import { useDocumentTitle } from "../lib/document-title.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

export function ProfilesPage() {
  const t = useT();
  useDocumentTitle(t.profilesPage.title);
  const profiles = useQuery(queries.agentProfiles());
  const settings = useQuery(queries.providerSettings());
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit" | "delete"; profile: Json<AgentProfile> } | null
  >(null);
  if (profiles.error) return <QueryError error={profiles.error} />;
  if (!profiles.data) return <Loading />;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t.profilesPage.title} description={t.profilesPage.help}>
        <Button onClick={() => setDialog({ kind: "create" })}>
          <PlusIcon />
          {t.profilesPage.new}
        </Button>
      </PageHeader>
      {profiles.data.length === 0 && <EmptyState>{t.profilesPage.empty}</EmptyState>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {profiles.data.map((profile) => (
          <Card key={profile.id} className="card-interactive flex flex-col">
            <CardHeader>
              <CardTitle>
                <ProfileChip
                  name={profile.name}
                  icon={profile.icon}
                  color={profile.color}
                  className="px-2.5 py-1 text-sm"
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3 text-sm">
              <ol className="flex flex-col gap-2">
                {profile.models.map((model, index) => {
                  const disabled =
                    settings.data !== undefined && settings.data[model.kind] === false;
                  return (
                    // The order is the identity of an entry: the list is read-only here.
                    // biome-ignore lint/suspicious/noArrayIndexKey: positions are the fallback order.
                    <li key={index} className="flex flex-wrap items-center gap-2">
                      <Badge variant={index === 0 ? "default" : "secondary"}>
                        {index === 0 ? t.profilesPage.primary : t.profilesPage.fallback(index)}
                      </Badge>
                      <span className={disabled ? "text-muted-foreground line-through" : undefined}>
                        {model.kind} · {model.model ?? t.profilesPage.noModel}
                        {model.effort && ` · ${t.profilesPage.effort(model.effort)}`}
                      </span>
                      {disabled && (
                        <>
                          <Badge variant="destructive">{t.profilesPage.providerDisabled}</Badge>
                          <Link
                            to="/settings"
                            className="text-xs text-primary-text underline underline-offset-2"
                          >
                            {t.profilesPage.enableInSettings}
                          </Link>
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>
              <div className="mt-auto flex gap-2 border-t border-border-light pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t.profilesPage.editAria(profile.name)}
                  onClick={() => setDialog({ kind: "edit", profile })}
                >
                  {t.profilesPage.edit}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t.profilesPage.deleteAria(profile.name)}
                  className="hover:border-danger/40 hover:bg-danger/[0.06] hover:text-danger-text"
                  onClick={() => setDialog({ kind: "delete", profile })}
                >
                  {t.profilesPage.delete}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {dialog?.kind === "create" && <ProfileFormDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && (
        <ProfileFormDialog profile={dialog.profile} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && (
        <ProfileDeleteDialog profile={dialog.profile} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
