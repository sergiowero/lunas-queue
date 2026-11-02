// Sample data for tests of other packages. Each call returns a new copy.
import type { SpecContent } from "./spec.ts";

export function specContentExample(): SpecContent {
  return {
    deliverable: "code",
    domainModel: {
      boundedContext: "Pedidos",
      glossary: [{ term: "Pending order", definition: "Confirmed order that has not shipped yet" }],
      aggregates: [{ name: "Order", entities: ["OrderLine"] }],
      invariants: ["Only a pending order can be cancelled"],
      events: [{ name: "OrderCancelled", description: "The customer cancelled a pending order" }],
    },
    requirements: [
      "The customer can cancel a pending order from their orders view",
      "A shipped order cannot be cancelled",
    ],
    criteria: [
      {
        id: "AC-1",
        given: "a pending order",
        when: "the customer cancels it",
        outcome: "the order ends up cancelled and OrderCancelled is emitted",
      },
      {
        id: "AC-2",
        given: "a shipped order",
        when: "the customer tries to cancel it",
        outcome: "the cancellation is rejected with a reason",
      },
    ],
    taskList: [
      { id: "T-1", title: "Comando CancelOrder en el agregado", criterionIds: ["AC-1", "AC-2"] },
    ],
  };
}
