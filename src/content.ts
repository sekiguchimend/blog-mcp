import MarkdownIt from "markdown-it";
import sanitizeHtmlLib from "sanitize-html";

// Keep this allow-list in lock-step with apps/web/src/lib/blog.ts so content is
// sanitized identically on write (here) and on render (the website).
const SANITIZE_CONFIG: sanitizeHtmlLib.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "a", "strong", "em", "u", "s", "sub", "sup",
    "table", "thead", "tbody", "tr", "th", "td",
    "img", "figure", "figcaption",
    "div", "span",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    "*": ["class", "id"],
  },
  disallowedTagsMode: "discard",
};

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

export type BodyFormat = "markdown" | "html";

export interface RenderedBody {
  html: string;
  text: string;
}

/**
 * Turn an authored body into the stored representation: sanitized HTML plus a
 * plain-text rendering (used for previews/search). Markdown is rendered first,
 * then sanitized; raw HTML is sanitized directly. In both cases the stored HTML
 * is guaranteed to pass the same allow-list the website enforces at render.
 */
export function renderBody(body: string, format: BodyFormat = "markdown"): RenderedBody {
  const rawHtml = format === "markdown" ? md.render(body) : body;
  const html = sanitizeHtmlLib(rawHtml, SANITIZE_CONFIG);
  const text = htmlToText(html);
  return { html, text };
}

/** Strip all tags to a collapsed plain-text string. */
export function htmlToText(html: string): string {
  const stripped = sanitizeHtmlLib(html, { allowedTags: [], allowedAttributes: {} });
  return stripped.replace(/\s+/g, " ").trim();
}

/**
 * Derive a URL slug from a title. ASCII-only: returns "" for titles that have no
 * latin characters (e.g. Japanese), so callers can require an explicit slug.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
