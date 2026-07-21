import { NextResponse } from "next/server";

/** The requested article (or its linked Shopify source) doesn't exist. */
export class KnowledgeNotFoundError extends Error {}

/** The request itself is invalid (e.g. resyncing a manual article with no linked Shopify source). */
export class KnowledgeValidationError extends Error {}

/** Resolving content from Shopify failed (all resolvers missed, or the Shopify API call errored). */
export class KnowledgeImportError extends Error {}

/** Maps the knowledge-service error types to HTTP responses; falls back to 500 for anything else. */
export function knowledgeErrorResponse(error: unknown): NextResponse {
  if (error instanceof KnowledgeNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof KnowledgeValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof KnowledgeImportError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }

  const message = error instanceof Error ? error.message : "Unexpected error.";
  console.error("[knowledge-api]", error);
  return NextResponse.json({ error: message }, { status: 500 });
}
