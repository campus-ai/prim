/** Fictional fixtures only. Never pass these records to a production API. */
export const SAMPLE_NOTE = [
  "Fictional engineering conversation:",
  "Maya: Could we call fetch directly for the order service?",
  "Ravi: Use the shared HTTP client for service calls. We need retries and request tracing to stay consistent.",
  "Maya: Agreed. Let's reject direct fetch calls because they duplicate that policy.",
  "Ravi: Also, the team demo is at three.",
].join("\n");

export const SAMPLE_DECISIONS = [
  {
    id: "demo-http-client",
    decision: "Use the shared HTTP client for service calls",
    stage: "provisional",
    source: "Fictional engineering conversation",
    evidence: [
      "Use the shared HTTP client for service calls. We need retries and request tracing to stay consistent.",
      "Let's reject direct fetch calls because they duplicate that policy.",
    ],
    rationale: "Centralize retries and request tracing.",
    files: ["service.ts"],
    scopeBasis: "Demo mapping from service calls to service.ts; the conversation names no file.",
    alternativesRejected: ["Direct fetch calls with duplicated retry and tracing policy"],
  },
  {
    id: "demo-order-repository",
    decision: "Persist orders through the shared order repository",
    stage: "adopted",
    source: "User confirmation of this fictional proposal",
    rationale: "Keep validation and persistence consistent across order writers.",
    files: ["orders.ts"],
    alternativesRejected: ["Direct local-storage writes that bypass repository validation"],
  },
] as const;

export const SAMPLE_FILES = {
  "service.ts":
    'import { http } from "./shared";\nexport const loadOrders = () => http.get("/orders");\n',
  "orders.ts":
    'import { orders } from "./shared";\nexport const saveOrder = (order: unknown) => orders.save(order);\n',
  "shared.ts":
    "// Fictional interfaces; this tour does not execute network or storage operations.\n" +
    "export declare const http: { get(path: string): Promise<unknown> };\n" +
    "export declare const orders: { save(order: unknown): void };\n",
} as const;

export const WARNING_EDIT = 'export const loadOrders = () => fetch("/orders");\n';
export const BLOCKED_EDIT =
  'export const saveOrder = (order: unknown) => localStorage.setItem("order", JSON.stringify(order));\n';
