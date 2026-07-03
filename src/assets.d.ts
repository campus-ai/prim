// HTML and SVG assets import as plain strings: tsup inlines them at build
// time (--loader ".html=text" / ".svg=text" in package.json), and the
// text-assets plugin in vitest.config.ts mirrors that for tests.
declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.svg" {
  const content: string;
  export default content;
}
