#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { BlogApiClient, isUuid, type AdminPost, type Translation } from "./api.js";
import { renderBody, slugify } from "./content.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example for required variables.`,
    );
  }
  return value;
}

const api = new BlogApiClient(
  requireEnv("NODEFLARE_API_URL"),
  requireEnv("BLOG_ADMIN_TOKEN"),
);

// Locales every published post must carry. Authoring requires both so a post
// is never invisible in one language (the public API only shows a post in a
// locale when that locale — or the English fallback — exists).
const REQUIRED_LOCALES = ["en", "ja"] as const;

const bodyFormat = z
  .enum(["markdown", "html"])
  .optional()
  .describe("Format of `body`: 'markdown' (default, converted to HTML) or 'html'");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
    isError: true as const,
  };
}

// Resolve a post reference (UUID or slug) to its UUID.
async function resolvePostId(ref: string): Promise<string> {
  if (isUuid(ref)) return ref;
  const post = await api.getPostBySlug(ref);
  return post.id;
}

// Resolve a category reference (UUID or slug) to its UUID.
async function resolveCategoryId(ref: string): Promise<string> {
  if (isUuid(ref)) return ref;
  const cats = await api.listCategories();
  const found = cats.find((c) => c.slug === ref);
  if (!found) throw new Error(`unknown category '${ref}'`);
  return found.id;
}

// Compact summary so list output stays readable.
function summarize(post: AdminPost) {
  return {
    id: post.id,
    slug: post.slug,
    status: post.status,
    publishDate: post.publishDate,
    locales: post.translations.map((t) => t.locale),
    title: post.translations[0]?.title,
    categories: post.categories.map((c) => c.slug),
  };
}

// A post may only be published when it carries every required locale, so it is
// never visible in one language and blank in the other.
async function assertBilingual(id: string): Promise<void> {
  const post = await api.getPost(id);
  const have = new Set(post.translations.map((t) => t.locale));
  const missing = REQUIRED_LOCALES.filter((l) => !have.has(l));
  if (missing.length > 0) {
    throw new Error(
      `cannot publish: missing ${missing.join(", ")} translation(s). ` +
        `Add them with set_translation before publishing — both ${REQUIRED_LOCALES.join(" and ")} are required.`,
    );
  }
}

// ============================================================
// POSTS
// ============================================================

function registerTools(server: McpServer) {
server.tool(
  "list_posts",
  "List all blog posts (drafts and published), newest first. Returns a compact summary per post (id, slug, status, publishDate, available locales, categories).",
  {},
  async () => {
    try {
      const posts = await api.listPosts();
      return ok({ count: posts.length, posts: posts.map(summarize) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_post",
  "Fetch one blog post in full, including every locale's translation (title, excerpt, HTML body) and its categories.",
  {
    post: z.string().describe("Post UUID or slug"),
  },
  async ({ post }) => {
    try {
      const id = await resolvePostId(post);
      return ok(await api.getPost(id));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "create_post",
  "Create a new blog post. BOTH an English and a Japanese translation are required (a post must never be visible in only one language). Bodies are converted to sanitized HTML (markdown by default). Slug is auto-derived from the English title when omitted. Defaults to a draft — pass status:'published' to publish immediately (allowed because both locales are present).",
  {
    title_en: z.string().describe("English title"),
    body_en: z.string().describe("English body (markdown by default; see body_format)"),
    excerpt_en: z.string().optional().describe("English summary shown in listings"),
    title_ja: z.string().describe("Japanese title（日本語タイトル）"),
    body_ja: z.string().describe("Japanese body（日本語本文, markdown by default）"),
    excerpt_ja: z.string().optional().describe("Japanese summary（日本語の概要）"),
    body_format: bodyFormat,
    slug: z.string().optional().describe("URL slug; auto-derived from the English title if omitted"),
    category_slugs: z
      .array(z.string())
      .optional()
      .describe("Category slugs to attach (categories must already exist)"),
    status: z.enum(["draft", "published"]).optional().describe("default 'draft'"),
    publish_date: z
      .string()
      .optional()
      .describe("ISO-8601 publish date; defaults to now when publishing"),
  },
  async ({
    title_en,
    body_en,
    excerpt_en,
    title_ja,
    body_ja,
    excerpt_ja,
    body_format,
    slug,
    category_slugs,
    status,
    publish_date,
  }) => {
    try {
      const resolvedSlug = (slug && slug.trim()) || slugify(title_en);
      if (!resolvedSlug) {
        throw new Error("could not derive a slug from title_en; pass an explicit `slug`");
      }
      const fmt = body_format ?? "markdown";
      const en = renderBody(body_en, fmt);
      const ja = renderBody(body_ja, fmt);
      // Create as a draft with the English base translation, add the Japanese
      // translation, then publish if requested — so the post always carries
      // both locales before it can go live.
      const created = await api.createPost({
        slug: resolvedSlug,
        status: "draft",
        publishDate: publish_date,
        category_slugs,
        translation: {
          locale: "en",
          title: title_en,
          excerpt: excerpt_en ?? null,
          content_html: en.html,
          content_text: en.text,
        },
      });
      await api.upsertTranslation(created.id, "ja", {
        title: title_ja,
        excerpt: excerpt_ja ?? null,
        content_html: ja.html,
        content_text: ja.text,
      });
      const final =
        (status ?? "draft") === "published"
          ? await api.publishPost(created.id, publish_date)
          : await api.getPost(created.id);
      return ok(final);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "update_post",
  "Update a blog post. Post-level fields (slug, status, category_slugs, publish_date) update directly. If any of title/excerpt/body are given, that locale's translation is updated — unspecified translation fields are preserved from the existing translation.",
  {
    post: z.string().describe("Post UUID or slug"),
    slug: z.string().optional().describe("New slug"),
    status: z.enum(["draft", "published"]).optional(),
    publish_date: z.string().optional().describe("ISO-8601 publish date"),
    category_slugs: z
      .array(z.string())
      .optional()
      .describe("Replaces the post's category set entirely"),
    locale: z.string().optional().describe("Locale to edit when changing title/excerpt/body (default 'en')"),
    title: z.string().optional(),
    excerpt: z.string().optional(),
    body: z.string().optional().describe("New body (see body_format)"),
    body_format: bodyFormat,
  },
  async ({ post, slug, status, publish_date, category_slugs, locale, title, excerpt, body, body_format }) => {
    try {
      const id = await resolvePostId(post);
      const loc = locale ?? "en";

      let translation: Translation | undefined;
      if (title !== undefined || excerpt !== undefined || body !== undefined) {
        const current = await api.getPost(id);
        const existing = current.translations.find((t) => t.locale === loc);
        const finalTitle = title ?? existing?.title;
        if (!finalTitle) {
          throw new Error(`locale '${loc}' has no existing translation; a title is required`);
        }
        let content_html = existing?.content_html ?? null;
        let content_text = existing?.content_text ?? null;
        if (body !== undefined) {
          const rendered = renderBody(body, body_format ?? "markdown");
          content_html = rendered.html;
          content_text = rendered.text;
        }
        translation = {
          locale: loc,
          title: finalTitle,
          excerpt: excerpt !== undefined ? excerpt : existing?.excerpt ?? null,
          content_html,
          content_text,
        };
      }

      const updated = await api.updatePost(id, {
        slug,
        status,
        publishDate: publish_date,
        category_slugs,
        translation,
      });
      if (status === "published") {
        try {
          await assertBilingual(id);
        } catch (e) {
          // Never leave a single-locale post live — roll back the publish.
          await api.unpublishPost(id);
          throw e;
        }
      }
      return ok(updated);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "set_translation",
  "Add or replace a single locale's translation of a post (e.g. add the Japanese version of an English post). The body is converted to sanitized HTML.",
  {
    post: z.string().describe("Post UUID or slug"),
    locale: z.string().describe("Locale, e.g. 'ja' or 'en'"),
    title: z.string(),
    body: z.string().describe("Body (see body_format)"),
    body_format: bodyFormat,
    excerpt: z.string().optional(),
  },
  async ({ post, locale, title, body, body_format, excerpt }) => {
    try {
      const id = await resolvePostId(post);
      const rendered = renderBody(body, body_format ?? "markdown");
      const updated = await api.upsertTranslation(id, locale, {
        title,
        excerpt: excerpt ?? null,
        content_html: rendered.html,
        content_text: rendered.text,
      });
      return ok(updated);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "delete_translation",
  "Remove one locale's translation from a post (the post and its other locales remain).",
  {
    post: z.string().describe("Post UUID or slug"),
    locale: z.string().describe("Locale to remove"),
  },
  async ({ post, locale }) => {
    try {
      const id = await resolvePostId(post);
      return ok(await api.deleteTranslation(id, locale));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "publish_post",
  "Publish a post so it appears on the public website. Stamps the publish date with the given date, the existing date, or now.",
  {
    post: z.string().describe("Post UUID or slug"),
    publish_date: z.string().optional().describe("ISO-8601; defaults to now"),
  },
  async ({ post, publish_date }) => {
    try {
      const id = await resolvePostId(post);
      await assertBilingual(id);
      return ok(await api.publishPost(id, publish_date));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "unpublish_post",
  "Revert a post to draft so it is hidden from the public website (content is kept).",
  {
    post: z.string().describe("Post UUID or slug"),
  },
  async ({ post }) => {
    try {
      const id = await resolvePostId(post);
      return ok(await api.unpublishPost(id));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "delete_post",
  "Permanently delete a post and all of its translations and category links. This cannot be undone.",
  {
    post: z.string().describe("Post UUID or slug"),
  },
  async ({ post }) => {
    try {
      const id = await resolvePostId(post);
      await api.deletePost(id);
      return ok({ deleted: true, id });
    } catch (e) {
      return fail(e);
    }
  },
);

// ============================================================
// CATEGORIES
// ============================================================

server.tool(
  "list_categories",
  "List all blog categories with their per-locale names.",
  {},
  async () => {
    try {
      return ok(await api.listCategories());
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "create_category",
  "Create a blog category. Provide a slug and either a single name (+optional locale) or a list of localized names.",
  {
    slug: z.string().describe("URL-safe category slug"),
    name: z.string().optional().describe("Name for a single locale (used with `locale`)"),
    locale: z.string().optional().describe("Locale for `name` (default 'en')"),
    names: z
      .array(z.object({ locale: z.string(), name: z.string() }))
      .optional()
      .describe("Localized names; overrides name/locale when given"),
  },
  async ({ slug, name, locale, names }) => {
    try {
      const translations =
        names && names.length > 0
          ? names
          : name
            ? [{ locale: locale ?? "en", name }]
            : [];
      if (translations.length === 0) {
        throw new Error("provide `name` (with optional `locale`) or `names`");
      }
      return ok(await api.createCategory({ slug, translations }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "update_category",
  "Update a category's slug and/or upsert localized names (omitted locales are left unchanged).",
  {
    category: z.string().describe("Category UUID or slug"),
    slug: z.string().optional().describe("New slug"),
    names: z
      .array(z.object({ locale: z.string(), name: z.string() }))
      .optional()
      .describe("Localized names to upsert"),
  },
  async ({ category, slug, names }) => {
    try {
      const id = await resolveCategoryId(category);
      return ok(await api.updateCategory(id, { slug, translations: names }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "delete_category",
  "Delete a category. Posts in it are not deleted; they simply lose the category.",
  {
    category: z.string().describe("Category UUID or slug"),
  },
  async ({ category }) => {
    try {
      const id = await resolveCategoryId(category);
      await api.deleteCategory(id);
      return ok({ deleted: true, id });
    } catch (e) {
      return fail(e);
    }
  },
);

// ============================================================
// UTILITIES
// ============================================================

server.tool(
  "preview_html",
  "Render a body to the exact sanitized HTML (and plain text) that would be stored, without saving anything. Use to check formatting before create/update.",
  {
    body: z.string().describe("Body to render"),
    body_format: bodyFormat,
  },
  async ({ body, body_format }) => {
    try {
      const rendered = renderBody(body, body_format ?? "markdown");
      return ok(rendered);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "suggest_slug",
  "Suggest a URL slug derived from a title (returns empty for non-latin titles, which need an explicit slug).",
  {
    title: z.string(),
  },
  async ({ title }) => {
    return ok({ slug: slugify(title) });
  },
);
}

// ============================================================
// START — stdio (local) or Streamable HTTP (remote, default)
// ============================================================

function newServer(): McpServer {
  const server = new McpServer({ name: "blog-mcp", version: "1.0.0" });
  registerTools(server);
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Optional shared-secret gate for the HTTP endpoint. When MCP_AUTH_TOKEN is set,
// requests must send `Authorization: Bearer <token>`. On NodeFlare the platform
// proxy already gates access, so this is an extra belt-and-suspenders for
// standalone hosting; leave it unset to rely on the platform.
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return true;
  const header = req.headers["authorization"];
  return header === `Bearer ${expected}`;
}

async function startHttp() {
  const port = Number(process.env.PORT ?? process.env.MCP_PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== "/mcp") {
      // Lightweight health check for the platform / load balancers.
      if (url === "/health" || url === "/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "blog-mcp" }));
        return;
      }
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({ error: "unauthorized" }),
      );
      return;
    }
    if (req.method !== "POST") {
      // Stateless: no server-initiated SSE stream or session termination.
      res.writeHead(405, { allow: "POST", "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed (stateless HTTP)" },
          id: null,
        }),
      );
      return;
    }
    // Stateless Streamable HTTP: a fresh server + transport per request.
    const server = newServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (err) {
      console.error("HTTP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  });
  httpServer.listen(port, host, () => {
    console.error(`blog-mcp listening on http://${host}:${port}/mcp (Streamable HTTP)`);
  });
}

async function startStdio() {
  const server = newServer();
  await server.connect(new StdioServerTransport());
  console.error("blog-mcp started on stdio");
}

async function main() {
  // Remote-first: default to HTTP. Set MCP_TRANSPORT=stdio for local use.
  const transport = (process.env.MCP_TRANSPORT ?? "http").toLowerCase();
  if (transport === "stdio") {
    await startStdio();
  } else {
    await startHttp();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
