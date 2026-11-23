// A task's phase instructions (docs/design.md §Phase instructions): free text the human addresses to
// the agent of one phase. They can be added, edited and removed in any task state, so the panel is
// never read-only. The list is the task's own (GET /api/tasks/:id); every change refetches it.
import type { InstructionPhase, PhaseInstruction } from "@lunasq/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Json } from "../../lib/api.ts";
import { useErrorText } from "../../lib/error-text.ts";
import { useT } from "../../lib/i18n.ts";
import { Muted, Section } from "../section.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Label, Select, Textarea } from "../ui/input.tsx";
import { INSTRUCTION_PHASES, InstructionForm } from "./instruction-form.tsx";

function useInstructionMutation<V>(taskId: string, mutationFn: (variables: V) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
  });
}

function EditInstruction({
  taskId,
  instruction,
  onDone,
}: {
  taskId: string;
  instruction: Json<PhaseInstruction>;
  onDone: () => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const [phase, setPhase] = useState<InstructionPhase>(instruction.phase);
  const [text, setText] = useState(instruction.text);
  const save = useInstructionMutation(taskId, () =>
    api.updateInstruction(taskId, instruction.id, { phase, text }),
  );
  const empty = text.trim() === "";
  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex flex-col gap-1 sm:w-56">
        <Label htmlFor={`edit-${instruction.id}-phase`}>{t.instructions.phase}</Label>
        <Select
          id={`edit-${instruction.id}-phase`}
          data-editing
          value={phase}
          onChange={(e) => setPhase(e.target.value as InstructionPhase)}
        >
          {INSTRUCTION_PHASES.map((p) => (
            <option key={p} value={p}>
              {t.phase[p]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`edit-${instruction.id}-text`}>{t.instructions.text}</Label>
        <Textarea
          id={`edit-${instruction.id}-text`}
          data-editing
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={empty || save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: onDone })}
        >
          {t.instructions.save}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t.instructions.cancel}
        </Button>
      </div>
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(save.error)}
        </p>
      )}
    </div>
  );
}

export function InstructionsPanel({
  taskId,
  instructions,
}: {
  taskId: string;
  instructions: Json<PhaseInstruction>[];
}) {
  const t = useT();
  const errorText = useErrorText();
  const [editing, setEditing] = useState<string | null>(null);
  const add = useInstructionMutation(taskId, (input: { phase: InstructionPhase; text: string }) =>
    api.addInstruction(taskId, input),
  );
  const remove = useInstructionMutation(taskId, (instructionId: string) =>
    api.removeInstruction(taskId, instructionId),
  );
  return (
    <Section title={t.instructions.title}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{t.instructions.hint}</p>
        {instructions.length === 0 ? (
          <Muted>{t.instructions.empty}</Muted>
        ) : (
          <ul aria-label={t.instructions.listAria} className="flex flex-col gap-1 text-sm">
            {instructions.map((instruction) => (
              <li
                key={instruction.id}
                className="flex flex-wrap items-start gap-2 rounded-md border border-border px-3 py-1.5"
              >
                {editing === instruction.id ? (
                  <EditInstruction
                    taskId={taskId}
                    instruction={instruction}
                    onDone={() => setEditing(null)}
                  />
                ) : (
                  <>
                    <Badge variant="secondary">{t.phase[instruction.phase]}</Badge>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                      {instruction.text}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t.instructions.editAria(t.phase[instruction.phase])}
                      onClick={() => setEditing(instruction.id)}
                    >
                      {t.instructions.edit}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t.instructions.removeAria(t.phase[instruction.phase])}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(instruction.id)}
                    >
                      {t.instructions.remove}
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {remove.error && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(remove.error)}
          </p>
        )}
        <InstructionForm
          idPrefix={`instruction-${taskId}`}
          pending={add.isPending}
          onAdd={(input) => add.mutateAsync(input)}
        />
        {add.error && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(add.error)}
          </p>
        )}
      </div>
    </Section>
  );
}
