// Phase selector + text + Add: how a human writes an instruction for the agent of one phase
// (refine, implement or verify). Shared by the new-task form and the task detail. It is not a
// <form>: the new-task page already is one, so Add is a plain button.
import type { InstructionPhase, PhaseInstructionInput } from "@lunasq/schemas";
import { useState } from "react";
import { useT } from "../../lib/i18n.ts";
import { PlusIcon } from "../icons.tsx";
import { Button } from "../ui/button.tsx";
import { Label, Select, Textarea } from "../ui/input.tsx";

export const INSTRUCTION_PHASES: readonly InstructionPhase[] = ["refine", "implement", "verify"];

export function InstructionForm({
  idPrefix,
  onAdd,
  pending = false,
}: {
  /** Makes the control ids unique when the form shows up more than once. */
  idPrefix: string;
  /** The form clears itself once `onAdd` resolves; if it rejects, the text stays. */
  onAdd: (input: PhaseInstructionInput) => unknown;
  pending?: boolean;
}) {
  const t = useT();
  const [phase, setPhase] = useState<InstructionPhase>("refine");
  const [text, setText] = useState("");
  const empty = text.trim() === "";

  const add = async () => {
    if (empty) return;
    try {
      await onAdd({ phase, text: text.trim() });
      setText("");
    } catch {
      // The caller shows the error; the text stays so nothing is lost.
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 sm:w-56">
        <Label htmlFor={`${idPrefix}-phase`}>{t.instructions.phase}</Label>
        <Select
          id={`${idPrefix}-phase`}
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-text`}>{t.instructions.text}</Label>
        <Textarea
          id={`${idPrefix}-text`}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t.instructions.textPlaceholder}
        />
      </div>
      <div>
        <Button variant="outline" size="sm" disabled={empty || pending} onClick={add}>
          <PlusIcon />
          {t.instructions.add}
        </Button>
      </div>
    </div>
  );
}
