// Profiles tab: the global agent profiles (docs/decisions/agent-profiles.md). Each one is an ordered
// list of models; a model whose provider is disabled in Settings is skipped and shown as disabled.
import type { AgentProfile } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ProfileDeleteDialog } from "../components/profile-delete-dialog.tsx";
import { ProfileFormDialog } from "../components/profile-form-dialog.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { Json } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

export function ProfilesPage() {
  const t = useT();
  const profiles = useQuery(queries.agentProfiles());
  const settings = useQuery(queries.providerSettings());
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit" | "delete"; profile: Json<AgentProfile> } | null
  >(null);
  if (profiles.error) return <QueryError error={profiles.error} />;
  if (!profiles.data) return <Loading />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t.profilesPage.title}</h1>
        <Button onClick={() => setDialog({ kind: "create" })}>{t.profilesPage.new}</Button>
      </div>
      <p className="text-sm text-muted-foreground">{t.profilesPage.help}</p>
      {profiles.data.length === 0 && (
        <p className="text-sm text-muted-foreground">{t.profilesPage.empty}</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {profiles.data.map((profile) => (
          <Card key={profile.id}>
            <CardHeader>
              <CardTitle>{profile.name}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
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
                          <Link to="/settings" className="text-xs underline">
                            {t.profilesPage.enableInSettings}
                          </Link>
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>
              <div className="mt-3 flex gap-2">
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
