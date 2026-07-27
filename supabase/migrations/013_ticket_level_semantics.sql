-- Corrective migration: 012's column comments describe the OLD level-4 rule
-- ("cosmetovigilance is always level 4"), which has since been replaced. 012 was
-- already applied to dev, so per the repo rule the file stays as a record of what
-- ran and the correction lands here instead.
--
-- No schema change: level is still a smallint 1-4 with the same check constraint.
-- What changed is the meaning of 4, and the comments are the copy of that rule
-- that lives in the database.
--
-- OLD: level 4 was implied by the subject -- cosmetovigilance always, and any
--      legal_privacy problem/complaint.
-- NEW: level 4 is a SEVERITY judgement that no (subject, kind) pair derives.
--      It is reserved for an explicit threat of legal action or public exposure,
--      hospitalisation, or grave injury/danger, and therefore reaches a ticket
--      only as a categoriser escalation read from the email text. It should be
--      rare.
--
-- Why: the Qiriness formulations are natural, so an adverse-reaction report is in
-- practice a mild allergy or irritation -- a level 2 problem answerable with
-- advice, not a manager escalation. Deriving 4 from the subject made "level 4"
-- mean "this topic" rather than "this is serious", which would have filled the
-- manager queue with routine mail and hidden the genuinely bad emails in it.
-- Likewise an RGPD erasure request is routine human work (level 3); a threat to
-- sue over one is the part that is level 4.
--
-- The derivation itself lives in scripts/lib/support-taxonomy.mjs (defaultLevel /
-- clampLevel); this migration only realigns the database's own documentation.

comment on column public.tickets.level is
  'Handling level 1-4, derived from (category, request_kind) by defaultLevel() in scripts/lib/support-taxonomy.mjs: 1 answerable from general knowledge, 2 needs the customer''s own record consulted and answered (no change), 3 needs something changed (refund, resend, cancellation, address change, commercial gesture). Subjects whose answers live in the database (order, delivery, payment, account, product_stock, promotions) floor at 2 for BOTH questions and problems, because most problems there are resolved by looking something up; the categoriser escalates to 3 itself when the fix requires a change. Level 4 is a severity judgement and is NOT derived from any subject -- reserved for an explicit threat of legal action or public exposure, hospitalisation, or grave injury/danger, so it can only arrive as a categoriser escalation and should be rare. The categoriser may escalate above the derived floor but never below it.';

comment on column public.tickets.category is
  'Primary subject, from the shared support taxonomy in scripts/lib/support-taxonomy.mjs -- the same 14 subjects knowledge articles use, so a ticket subject filters straight into the matching knowledge chunks. Constrained since 012. Note that no subject implies a handling level on its own; cosmetovigilance floors at level 2 for a reported reaction (see the level comment).';
