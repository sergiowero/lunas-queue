// Tabla genérica sobre TanStack Table con las piezas de shadcn/ui.
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";

export function DataTable<T>({
  columns,
  data,
  getRowId,
  empty,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: las columnas mezclan tipos de valor por celda.
  columns: ColumnDef<T, any>[];
  data: T[];
  getRowId: (row: T) => string;
  empty: string;
}) {
  const table = useReactTable({ columns, data, getRowId, getCoreRowModel: getCoreRowModel() });
  if (data.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <Table>
      <TableHeader>
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
  );
}
