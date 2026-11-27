// Generic table over TanStack Table with shadcn/ui pieces.
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { cn } from "../lib/utils.ts";
import { EmptyState } from "./status.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";

export function DataTable<T>({
  columns,
  data,
  getRowId,
  empty,
  framed = true,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: the columns mix value types per cell.
  columns: ColumnDef<T, any>[];
  data: T[];
  getRowId: (row: T) => string;
  empty: string;
  /** In its own card (page lists); false when the table already sits inside a card. */
  framed?: boolean;
}) {
  const table = useReactTable({ columns, data, getRowId, getCoreRowModel: getCoreRowModel() });
  if (data.length === 0) {
    return framed ? (
      <EmptyState>{empty}</EmptyState>
    ) : (
      <p className="text-sm text-muted-foreground">{empty}</p>
    );
  }
  return (
    <div className={cn(framed && "card overflow-hidden")}>
      <Table>
        <TableHeader className={cn(framed && "bg-surface-secondary/60")}>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
