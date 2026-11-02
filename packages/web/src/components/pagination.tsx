import { useT } from "../lib/i18n.ts";
import { Button } from "./ui/button.tsx";

export const PAGE_SIZE = 10;

export function Pagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  const t = useT();
  if (pageCount <= 1) return null;
  return (
    <nav aria-label={t.common.pagination} className="flex items-center justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={page === 0}
        onClick={() => onPageChange(page - 1)}
      >
        {t.common.previous}
      </Button>
      <span className="text-sm text-muted-foreground">{t.common.page(page + 1, pageCount)}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={page === pageCount - 1}
        onClick={() => onPageChange(page + 1)}
      >
        {t.common.next}
      </Button>
    </nav>
  );
}
