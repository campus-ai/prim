// Fictional records: never insert these into the shared Decision graph.
export const DEMO_SCENARIO_VERSION = 1;
export const DEMO_TASK = "Implement CSV export for customer records, including name and email.";
export const DEMO_ORIGINAL =
  "Exclude customer contact information e.g. email addresses from public-facing data pipelines";
export const DEMO_RATIONALE =
  "Customer contact details are collected for account communication, not public distribution. Keeping them out of public-facing pipelines supports our data-minimization and purpose-limitation obligations and reduces the risk of unauthorized disclosure.";
export const DEMO_REPLACEMENT = "Allow customer names and email addresses in CSV exports";
export const DEMO_INITIAL =
  '// Fictional customer export project.\nexport const customerCsv = "";\n';
export const DEMO_ADHERE =
  '// Fictional customer export project.\nexport const customerCsv = "name\\nAvery";\n';
export const DEMO_SUPERSEDE =
  '// Fictional customer export project.\nexport const customerCsv = "name,email\\nAvery,avery@example.invalid";\n';
