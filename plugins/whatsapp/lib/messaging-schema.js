import spec from "./messaging-v1.json" with { type: "json" };
export const messagingOperations = Object.fromEntries(
  Object.entries(spec.operations).map(([name, op]) => [
    name,
    {
      inputSchema: { ...op.input, definitions: spec.definitions },
      outputSchema: { ...op.output, definitions: spec.definitions },
    },
  ]),
);
