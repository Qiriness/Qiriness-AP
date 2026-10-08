/**
 * The team's own tags on social posts (81_social_post_tags.sql): created and
 * applied by a person in Insights → Social media → Posts, never by a sync.
 *
 * Read live, never through the Insights cache: a tag someone just added must
 * be there on the next render, and these are two small per-shop tables.
 *
 * Server-only.
 */

import {
  supabaseDelete,
  supabaseInsert,
  supabaseSelect,
  supabaseSelectAll,
  supabaseUpsert,
} from "../../../scripts/lib/supabase-rest-client.mjs";
import { SOCIAL_T, SOCIAL_TAG_T } from "../../../scripts/lib/tables.mjs";
import type { SocialTag, SocialTagLink } from "../social-types";
import { getShopId } from "./knowledge-service";
import { getSupabaseClient } from "./insights/shared";

export const TAG_NAME_MAX = 40;

export interface SocialTags {
  tags: SocialTag[];
  links: SocialTagLink[];
}

/** Every tag of the shop and every post it is on. Empty, never a throw, when the tables are missing. */
export async function readSocialTags(shopId?: string): Promise<SocialTags> {
  try {
    const supabase = getSupabaseClient();
    const shop = shopId ?? (await getShopId());
    const [tags, links] = await Promise.all([
      supabaseSelectAll(supabase, SOCIAL_TAG_T.TAGS, { shop_id: shop }, "id,name", { order: "name.asc" }) as Promise<{ id: string; name: string }[]>,
      supabaseSelectAll(supabase, SOCIAL_TAG_T.LINKS, { shop_id: shop }, "tag_id,account_id,external_id", { order: "created_at.asc" }) as Promise<
        { tag_id: string; account_id: string; external_id: string }[]
      >,
    ]);
    return {
      tags: tags.map((t) => ({ id: t.id, name: t.name })),
      links: links.map((l) => ({ tagId: l.tag_id, accountId: l.account_id, postId: l.external_id })),
    };
  } catch {
    return { tags: [], links: [] };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checked before an id reaches a filter, so a stray one is a 404 and not a database error. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A trimmed name of 1–40 characters, or the reason it is not one. */
export function checkTagName(value: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "name must be text" };
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "name is empty" };
  if (name.length > TAG_NAME_MAX) return { ok: false, error: `name is longer than ${TAG_NAME_MAX} characters` };
  return { ok: true, name };
}

/** Creates the tag, or returns the existing one of the same name (case ignored). */
export async function createSocialTag(name: string): Promise<SocialTag> {
  const supabase = getSupabaseClient();
  const shopId = await getShopId();
  const existing = (await supabaseSelectAll(supabase, SOCIAL_TAG_T.TAGS, { shop_id: shopId }, "id,name", { order: "name.asc" })) as SocialTag[];
  const same = existing.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (same) return { id: same.id, name: same.name };
  const [row] = (await supabaseInsert(supabase, SOCIAL_TAG_T.TAGS, [{ shop_id: shopId, name }])) as { id: string; name: string }[];
  return { id: row.id, name: row.name };
}

/** Deletes a tag and, through the cascade, every place it was applied. False when the shop has no such tag. */
export async function deleteSocialTag(tagId: string): Promise<boolean> {
  const deleted = await supabaseDelete(getSupabaseClient(), SOCIAL_TAG_T.TAGS, { id: tagId, shop_id: await getShopId() });
  return deleted.length > 0;
}

/**
 * Puts a tag on a post or takes it off. False when the tag is not the shop's or
 * the post is not stored for the shop, so nothing is written for a stray id.
 */
export async function setPostTag(tagId: string, accountId: string, postId: string, tagged: boolean): Promise<boolean> {
  const supabase = getSupabaseClient();
  const shopId = await getShopId();
  const [tag, post] = await Promise.all([
    supabaseSelect(supabase, SOCIAL_TAG_T.TAGS, { id: tagId, shop_id: shopId }, "id", { limit: 1 }),
    supabaseSelect(supabase, SOCIAL_T.POSTS, { account_id: accountId, external_id: postId, shop_id: shopId }, "external_id", { limit: 1 }),
  ]);
  if (!tag?.length || !post?.length) return false;
  const link = { tag_id: tagId, account_id: accountId, external_id: postId };
  if (tagged) await supabaseUpsert(supabase, SOCIAL_TAG_T.LINKS, [{ ...link, shop_id: shopId }], "tag_id,account_id,external_id", { returning: "minimal" });
  else await supabaseDelete(supabase, SOCIAL_TAG_T.LINKS, link);
  return true;
}
