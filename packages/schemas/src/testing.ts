// Datos de ejemplo para tests de otros paquetes. Cada llamada devuelve una copia nueva.
import type { SpecContent } from "./spec.ts";

export function specContentExample(): SpecContent {
  return {
    domainModel: {
      boundedContext: "Pedidos",
      glossary: [{ term: "Pedido pendiente", definition: "Pedido confirmado que aún no se envía" }],
      aggregates: [{ name: "Order", entities: ["OrderLine"] }],
      invariants: ["Solo un pedido pendiente puede cancelarse"],
      events: [{ name: "OrderCancelled", description: "El cliente canceló un pedido pendiente" }],
    },
    requirements: [
      "El cliente puede cancelar un pedido pendiente desde su vista de pedidos",
      "Un pedido enviado no se puede cancelar",
    ],
    criteria: [
      {
        id: "AC-1",
        given: "un pedido pendiente",
        when: "el cliente lo cancela",
        outcome: "el pedido queda cancelado y se emite OrderCancelled",
      },
      {
        id: "AC-2",
        given: "un pedido enviado",
        when: "el cliente intenta cancelarlo",
        outcome: "la cancelación se rechaza con un motivo",
      },
    ],
    taskList: [
      { id: "T-1", title: "Comando CancelOrder en el agregado", criterionIds: ["AC-1", "AC-2"] },
    ],
  };
}
