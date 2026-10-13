# blog-mcp

MCP server for authoring and managing the **NodeFlare blog**. The blog's content
lives in NodeFlare's own Neon Postgres (migrated off Hygraph) and is served to
the website by the Rust API. This MCP is the **only writer** — there is no admin
web UI. It is a thin, token-authenticated client over the blog admin API:

```
Claude → blog-mcp (HTTP /mcp or stdio) → POST /api/v1/blog/admin/... (Bearer BLOG_ADMIN_TOKEN) → Neon
website ← GET /api/v1/blog/... (public, published only) ←──────────────────────────────┘
```

## Transports

Remote-first. The server speaks **Streamable HTTP** by default so it can be
deployed (e.g. on NodeFlare) and added to Claude as a remote connector, and also
supports **stdio** for local use.

- `MCP_TRANSPORT=http` (default): listens on `PORT` (default 8080) at `/mcp`,
  stateless (`enableJsonResponse`), with a `/health` check. Optionally gate it
  with `MCP_AUTH_TOKEN` (`Authorization: Bearer …`); on NodeFlare the platform
  proxy already handles access.
- `MCP_TRANSPORT=stdio`: classic local stdio for a desktop MCP client.

## Setup

```bash
cp .env.example .env     # set NODEFLARE_API_URL and BLOG_ADMIN_TOKEN
npm install
npm run build
```

`BLOG_ADMIN_TOKEN` must match the value set on the API server
(`openssl rand -hex 32`).

Run it remotely (default) and add the `/mcp` URL to Claude as a custom
connector, or run it locally over stdio:

```bash
# remote (Streamable HTTP) — the default
npm start                         # listens on http://0.0.0.0:8080/mcp

# local stdio, e.g. for a desktop MCP client
MCP_TRANSPORT=stdio npm start
```

stdio client registration:

```json
{
  "mcpServers": {
    "blog": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/blog-mcp/dist/index.js"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

## Content model

- Posts are localized: each post has one translation per locale (`en`, `ja`).
  The website requests a locale and falls back to English when a translation is
  missing. **Both `en` and `ja` are required**: `create_post` takes both, and
  `publish_post`/`update_post` refuse to publish a post that is missing either
  locale (so a post is never visible in one language and blank in the other).
- Bodies are authored in **markdown** (or raw HTML) and stored as **sanitized
  HTML** — the same allow-list the website enforces at render time
  (`src/content.ts` mirrors `apps/web/src/lib/blog.ts`).
- Posts are `draft` until published. Only published posts appear on the site.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_posts` | List all posts (drafts + published) |
| `get_post` | Full post incl. all translations + categories |
| `create_post` | Create a post with **both** its English and Japanese translations (both required) |
| `update_post` | Update post-level fields and/or one locale's translation |
| `set_translation` | Add/replace a single locale's translation |
| `delete_translation` | Remove one locale |
| `publish_post` / `unpublish_post` | Toggle visibility |
| `delete_post` | Permanently delete a post |
| `list_categories` / `create_category` / `update_category` / `delete_category` | Manage categories |
| `preview_html` | Render body → stored HTML without saving |
| `suggest_slug` | Derive a slug from a title |

Posts and categories can be referenced by UUID **or** slug everywhere.
