/**
 * Internal notes on a ticket (`ticket_notes`, 04_ticket_numbers_and_notes.sql):
 * what the team writes for each other. Never sent to the customer and, for now,
 * never read by the drafting agent — docs/decisions/tickets-dashboard.md
 * § Internal notes.
 *
 * Server-only: it uses the service role. Never import from a client component.
 */
import { loadConfig } from "../../../scripts/lib/sync-config.mjs";
import {
  createSupabaseClient,
  supabaseInsert,
  supabaseSelect,
  supabaseUpdate,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { T } from "../../../scripts/lib/tables.mjs";
import { KnowledgeNotFoundError, KnowledgeValidationError } from "./knowledge-errors";
import type { CurrentUser } from "./auth";
import type { TicketNote } from "../types";

/** Mirrors ticket_notes_body_check. */
export const NOTE_MAX_LENGTH = 5000;

const NOTE_COLUMNS = "id,body,author_id,author_name,created_at";

function getSupabaseClient() {
  return createSupabaseClient(loadConfig(process.env as Record<string, string | undefined>));
}

type NoteRow = { id: string; body: string; author_id: string | null; author_name: string | null; created_at: string };

function mapNote(row: NoteRow, readerId: string | null): TicketNote {
  return {
    id: row.id,
    body: row.body,
    authorName: row.author_name,
    isMine: Boolean(readerId) && row.author_id === readerId,
    createdAt: row.created_at,
  };
}

async function assertTicket(shopId: string, ticketId: string) {
  const rows = await supabaseSelect(getSupabaseClient(), T.TICKETS, { id: ticketId, shop_id: shopId }, "id,deleted_at", { limit: 1 });
  if (!rows[0] || rows[0].deleted_at) throw new KnowledgeNotFoundError(`Ticket not found: ${ticketId}`);
}

/** The ticket's live notes, oldest first — the order the timeline merges them in. */
export async function listTicketNotes(shopId: string, ticketId: string, readerId: string | null): Promise<TicketNote[]> {
  const rows = (await supabaseSelect(
    getSupabaseClient(),
    T.TICKET_NOTES,
    { shop_id: shopId, ticket_id: ticketId, deleted_at: { operator: "is", value: "null" } },
    NOTE_COLUMNS,
    { order: "created_at.asc" }
  )) as NoteRow[];
  return rows.map((row) => mapNote(row, readerId));
}

export async function addTicketNote(
  shopId: string,
  ticketId: string,
  body: string,
  author: CurrentUser | null
): Promise<TicketNote> {
  const text = String(body ?? "").trim();
  if (!text) throw new KnowledgeValidationError("Write the note before adding it.");
  if (text.length > NOTE_MAX_LENGTH) {
    throw new KnowledgeValidationError(`A note can be ${NOTE_MAX_LENGTH} characters at most.`);
  }
  await assertTicket(shopId, ticketId);
  const [row] = (await supabaseInsert(getSupabaseClient(), T.TICKET_NOTES, [
    {
      shop_id: shopId,
      ticket_id: ticketId,
      body: text,
      author_id: author?.sub ?? null,
      author_name: author?.displayName?.trim() || author?.email?.split("@")[0] || null,
    },
  ])) as NoteRow[];
  return mapNote(row, author?.sub ?? null);
}

/**
 * Soft delete, and only by whoever wrote it: a note is someone's word on the
 * case, and the timeline should not lose it to a colleague's click.
 */
export async function deleteTicketNote(shopId: string, ticketId: string, noteId: string, readerId: string | null) {
  const rows = (await supabaseSelect(
    getSupabaseClient(),
    T.TICKET_NOTES,
    { id: noteId, shop_id: shopId, ticket_id: ticketId },
    "id,author_id,deleted_at",
    { limit: 1 }
  )) as { id: string; author_id: string | null; deleted_at: string | null }[];
  if (!rows[0] || rows[0].deleted_at) throw new KnowledgeNotFoundError(`Note not found: ${noteId}`);
  if (!readerId || rows[0].author_id !== readerId) {
    throw new KnowledgeValidationError("Only the person who wrote a note can delete it.");
  }
  await supabaseUpdate(
    getSupabaseClient(),
    T.TICKET_NOTES,
    { id: noteId, shop_id: shopId },
    { deleted_at: new Date().toISOString() },
    { returning: "minimal" }
  );
}
