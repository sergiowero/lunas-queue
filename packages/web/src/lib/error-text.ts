// Text of an API error in the effective language: known error codes use the dictionary and any
// other code falls back to the (English) message the API returned.
import { ApiError } from "./api.ts";
import type { Dictionary } from "./dictionary/index.ts";
import { useT } from "./i18n.ts";

export function errorText(error: Error, t: Dictionary): string {
  if (error instanceof ApiError) return t.apiErrors[error.code] ?? error.message;
  return error.message;
}

export function useErrorText(): (error: Error) => string {
  const t = useT();
  return (error) => errorText(error, t);
}
