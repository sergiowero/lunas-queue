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
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Paginación" className="flex items-center justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={page === 0}
        onClick={() => onPageChange(page - 1)}
      >
        Anterior
      </Button>
      <span className="text-sm text-muted-foreground">
        Página {page + 1} de {pageCount}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page === pageCount - 1}
        onClick={() => onPageChange(page + 1)}
      >
        Siguiente
      </Button>
    </nav>
  );
}
