-- ============================================================================
-- 59 — `order_identity: none` IS SPLIT INTO THE SITUATION IT WAS
--
-- WHAT THIS CHANGES. A rule's `when_conditions.order_identity` that names
-- `none` also names the five values `none` was split into
-- (agent/src/resolution/order-identity.mjs):
--
--   no_number_known_sender · no_number_unknown_sender · number_not_found
--   other_email_same_name · other_email
--
-- WHY. Every unconfirmed ticket was `none`, so every rule on it asked for the
-- order number AND the address, including a ticket whose customer had just
-- quoted the order from another mailbox (#6668, #6711).
--
-- `none` IS KEPT, deliberately. `normaliseConditions` drops a value it does not
-- know, and a condition left with no values is dropped with it, so the rule
-- would fire on EVERY ticket. Keeping both makes this safe in either order:
-- code from before the split reads `none` and ignores the new values, and code
-- after it ignores `none` and reads the new ones. The Rulebook removes `none`
-- the next time a rule is saved.
--
-- DATA: 15 approved rules and 1 draft on 2026-10-02. No schema change.
-- IDEMPOTENT: a rule already carrying all five is left alone.
-- ============================================================================

update public.support_answers
  set when_conditions = jsonb_set(
    when_conditions,
    '{order_identity}',
    (
      select jsonb_agg(value order by value)
      from (
        select jsonb_array_elements_text(when_conditions -> 'order_identity') as value
        union
        select unnest(array[
          'no_number_known_sender',
          'no_number_unknown_sender',
          'number_not_found',
          'other_email_same_name',
          'other_email'
        ])
      ) as merged
    )
  )
  where jsonb_typeof(when_conditions -> 'order_identity') = 'array'
    and when_conditions -> 'order_identity' ? 'none'
    and not (when_conditions -> 'order_identity' ?& array[
      'no_number_known_sender',
      'no_number_unknown_sender',
      'number_not_found',
      'other_email_same_name',
      'other_email'
    ]);
