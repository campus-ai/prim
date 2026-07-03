/**
 * The OAuth callback pages, assembled from one HTML template and a real
 * favicon asset.
 *
 * page.html and favicon.svg live beside this module as ordinary files so HTML
 * and SVG tooling can lint and format them; tsup inlines them as strings at
 * build time (--loader ".html=text" / ".svg=text", mirrored for tests by the
 * text-assets plugin in vitest.config.ts). The assembled pages are fully
 * self-contained — the throwaway localhost callback server makes zero
 * external requests.
 */
import faviconSvg from "./favicon.svg";
import pageTemplate from "./page.html";

const FAVICON_HREF = `data:image/svg+xml;base64,${Buffer.from(faviconSvg).toString("base64")}`;

const PLACEHOLDER_RE = /\{\{([A-Z_]+)\}\}/g;

// Placeholders are filled exclusively from the module-local constants in this
// file — nothing request- or provider-derived ever reaches the template. A
// placeholder without a value is a programming error, so fill() throws
// instead of silently serving a page with `{{...}}` left in it.
function fill(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`auth page template has no value for {{${key}}}`);
    }
    return value;
  });
}

function page(docTitle: string, eyebrow: string, title: string, detail: string): string {
  return fill(pageTemplate, {
    FAVICON_HREF,
    DOC_TITLE: docTitle,
    EYEBROW: eyebrow,
    TITLE: title,
    DETAIL: detail,
  });
}

export const AUTH_SUCCESS_PAGE = page(
  "Primitive — Authenticated",
  "Authenticated",
  "Authentication successful!",
  "You can close this tab.",
);

export const STATE_MISMATCH_PAGE = page(
  "Primitive — Authentication failed",
  "Error",
  "State mismatch. Authentication failed.",
  "Return to your terminal for details.",
);

export const AUTH_FAILURE_PAGE = page(
  "Primitive — Authentication failed",
  "Error",
  "Authentication failed.",
  "Return to your terminal for details.",
);
