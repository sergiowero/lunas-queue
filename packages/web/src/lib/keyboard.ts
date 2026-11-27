import type { KeyboardEvent } from "react";

/**
 * onKeyDown handler for a text area: Ctrl+Enter (or Cmd+Enter on macOS) runs `submit`, as the
 * form's button would. A plain Enter still inserts a line break.
 */
export function onModEnter(submit: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    submit();
  };
}
