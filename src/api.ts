// Thin typed client over the NodeFlare blog admin API. All DB logic lives in the
// Rust backend; this just carries the shared admin token and shapes requests.

export interface Translation {
  locale: string;
  title: string;
  excerpt?: string | null;
  content_html?: string | null;
  content_text?: string | null;
}

export interface AdminPost {
  id: string;
  slug: string;
  status: string;
  publishDate: string | null;
  created_at: string;
  updated_at: string;
  categories: Array<{ id: string; name: string; slug: string }>;
  translations: Translation[];
}

export interface AdminCategory {
  id: string;
  slug: string;
  translations: Array<{ locale: string; name: string }>;
}

export interface CreatePostBody {
  slug: string;
  status?: string;
  publishDate?: string;
  category_slugs?: string[];
  translation: Translation;
}

export interface UpdatePostBody {
  slug?: string;
  status?: string;
  publishDate?: string;
  category_slugs?: string[];
  translation?: Translation;
}

export class BlogApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1/blog${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) {
      return undefined as T;
    }
    const raw = await res.text();
    if (!res.ok) {
      let message = raw;
      try {
        const parsed = JSON.parse(raw);
        message = parsed?.error?.message || parsed?.message || raw;
      } catch {
        // keep raw text
      }
      throw new Error(`API ${method} ${path} failed (${res.status}): ${message}`);
    }
    return (raw ? JSON.parse(raw) : undefined) as T;
  }

  // --- posts ---
  listPosts(): Promise<AdminPost[]> {
    return this.request("GET", "/admin/posts");
  }
  getPost(id: string): Promise<AdminPost> {
    return this.request("GET", `/admin/posts/${encodeURIComponent(id)}`);
  }
  getPostBySlug(slug: string): Promise<AdminPost> {
    return this.request("GET", `/admin/post-by-slug/${encodeURIComponent(slug)}`);
  }
  createPost(body: CreatePostBody): Promise<AdminPost> {
    return this.request("POST", "/admin/posts", body);
  }
  updatePost(id: string, body: UpdatePostBody): Promise<AdminPost> {
    return this.request("PATCH", `/admin/posts/${encodeURIComponent(id)}`, body);
  }
  deletePost(id: string): Promise<void> {
    return this.request("DELETE", `/admin/posts/${encodeURIComponent(id)}`);
  }
  publishPost(id: string, publishDate?: string): Promise<AdminPost> {
    return this.request("POST", `/admin/posts/${encodeURIComponent(id)}/publish`, {
      publishDate,
    });
  }
  unpublishPost(id: string): Promise<AdminPost> {
    return this.request("POST", `/admin/posts/${encodeURIComponent(id)}/unpublish`);
  }
  upsertTranslation(
    id: string,
    locale: string,
    body: Omit<Translation, "locale">,
  ): Promise<AdminPost> {
    return this.request(
      "PUT",
      `/admin/posts/${encodeURIComponent(id)}/translations/${encodeURIComponent(locale)}`,
      body,
    );
  }
  deleteTranslation(id: string, locale: string): Promise<AdminPost> {
    return this.request(
      "DELETE",
      `/admin/posts/${encodeURIComponent(id)}/translations/${encodeURIComponent(locale)}`,
    );
  }

  // --- categories ---
  listCategories(): Promise<AdminCategory[]> {
    return this.request("GET", "/admin/categories");
  }
  createCategory(body: {
    slug: string;
    translations: Array<{ locale: string; name: string }>;
  }): Promise<AdminCategory> {
    return this.request("POST", "/admin/categories", body);
  }
  updateCategory(
    id: string,
    body: { slug?: string; translations?: Array<{ locale: string; name: string }> },
  ): Promise<AdminCategory> {
    return this.request("PATCH", `/admin/categories/${encodeURIComponent(id)}`, body);
  }
  deleteCategory(id: string): Promise<void> {
    return this.request("DELETE", `/admin/categories/${encodeURIComponent(id)}`);
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
