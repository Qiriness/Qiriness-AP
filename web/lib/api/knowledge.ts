/**
 * Client-side wrapper around the Knowledge API (web/app/api/knowledge/*).
 * Used for mutations triggered by user interaction; the initial article/
 * source lists are fetched server-side in web/app/agent-setup/page.tsx to
 * avoid a loading flash, using the same mapping in ./knowledge-mapper.
 */

import type { Article, KnowledgeCategory } from "@/lib/types";
import { mapArticleResponse } from "@/lib/knowledge-mapper";

export class KnowledgeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "KnowledgeApiError";
    this.status = status;
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new KnowledgeApiError(body?.error || `Request failed (${response.status}).`, response.status);
  }
  return body as T;
}

export interface CreateArticlePayload {
  title?: string;
  category?: KnowledgeCategory;
  sourceId?: string | null;
}

export interface UpdateArticlePayload {
  title?: string;
  content?: string;
  category?: KnowledgeCategory;
  approvalStatus?: Article["status"];
  sourceId?: string;
}

export async function createArticle(payload: CreateArticlePayload): Promise<Article> {
  const { article } = await request<{ article: Parameters<typeof mapArticleResponse>[0] }>(
    "/api/knowledge/articles",
    { method: "POST", body: JSON.stringify(payload) }
  );
  return mapArticleResponse(article);
}

export async function updateArticle(id: string, payload: UpdateArticlePayload): Promise<Article> {
  const { article } = await request<{ article: Parameters<typeof mapArticleResponse>[0] }>(
    `/api/knowledge/articles/${id}`,
    { method: "PATCH", body: JSON.stringify(payload) }
  );
  return mapArticleResponse(article);
}

export async function resyncArticle(id: string): Promise<Article> {
  const { article } = await request<{ article: Parameters<typeof mapArticleResponse>[0] }>(
    `/api/knowledge/articles/${id}/resync`,
    { method: "POST" }
  );
  return mapArticleResponse(article);
}

export async function deleteArticle(id: string): Promise<void> {
  await request<void>(`/api/knowledge/articles/${id}`, { method: "DELETE" });
}

/** Extracts a user-facing message from any error thrown by the functions above. */
export function knowledgeErrorMessage(error: unknown): string {
  if (error instanceof KnowledgeApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}
