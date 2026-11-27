// Browser tab title: «<page> — LunasQ», prefixed with «(N)» while the Inbox has N pending items so
// the tab says when something waits for the human. Pages set their part; the Layout sets the count.
import { useEffect, useSyncExternalStore } from "react";

const APP = "LunasQ";
const listeners = new Set<() => void>();
let page = "";

function emit() {
  for (const l of listeners) l();
}

export function composeTitle(pageTitle: string, pending: number): string {
  const base = pageTitle ? `${pageTitle} — ${APP}` : APP;
  return pending > 0 ? `(${pending}) ${base}` : base;
}

/** A page's part of the tab title; cleared when the page unmounts. */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    page = title ?? "";
    emit();
    return () => {
      page = "";
      emit();
    };
  }, [title]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Writes the composed title; mounted once in the Layout. */
export function useTitleWriter(pending: number) {
  const current = useSyncExternalStore(
    subscribe,
    () => page,
    () => page,
  );
  useEffect(() => {
    document.title = composeTitle(current, pending);
  }, [current, pending]);
}
