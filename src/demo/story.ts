// Fictional records: never insert these into the shared Decision graph.
export const DEMO_SCENARIO_VERSION = 1;
export const DEMO_TASK = "Implement CSV export for customer records, including name and email.";
export const DEMO_ORIGINAL = "Exclude customer email addresses from CSV exports";
export const DEMO_RATIONALE = "Keep customer contact details out of exported files.";
export const DEMO_REPLACEMENT = "Allow customer names and email addresses in CSV exports";
export const DEMO_INITIAL =
  '// Fictional customer export project.\nexport const customerCsv = "";\n';
export const DEMO_ADHERE =
  '// Fictional customer export project.\nexport const customerCsv = "name\\nAvery";\n';
export const DEMO_SUPERSEDE =
  '// Fictional customer export project.\nexport const customerCsv = "name,email\\nAvery,avery@example.invalid";\n';
