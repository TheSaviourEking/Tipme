-- Fee waivers (spec 2026-11-23 §5, plan W15, pre-flight rulings R2 and R3): the rule replaces the
-- `business_payout_fee_absorbed` switch. One kind rule for the business withdrawal fee, matching the
-- switch's stored value at release: TipMe pays when it is on, the business pays (today's rule)
-- otherwise, including when no row was ever stored. Shipped with the code that stops reading the
-- switch, so no change to it is lost between the two. Set by no staff member, with a system audit
-- row like a staff change (fee_waiver.set), as 0118 did. The id is fixed, so it is written once; the
-- test reset seeds the same row (test-support.ts). The switch's own row stays, and nothing reads it.
WITH switch AS (
  SELECT COALESCE(
    (SELECT enabled FROM feature_switches WHERE key = 'business_payout_fee_absorbed'),
    false
  ) AS enabled
), added AS (
  INSERT INTO fee_waivers (id, scope, kind, profile_id, business_id, fee, payer, starts_at, ends_at,
    reason, set_by, approved_by, created_at)
  SELECT '00000000-0000-4000-8000-000000000130', 'kind', 'business', NULL, NULL, 'withdrawal',
         CASE WHEN switch.enabled THEN 'tipme' ELSE 'account' END, clock_timestamp(), NULL,
         'Carried over from the switch', NULL, NULL, clock_timestamp()
    FROM switch
  ON CONFLICT (id) DO NOTHING
  RETURNING id, payer
)
INSERT INTO audit_events (id, staff_user_id, action, permission, subject_type, subject_id, reason, created_at)
SELECT gen_random_uuid(), NULL, 'fee_waiver.set', 'fees.manage', 'fee_waiver', added.id::text,
       'Carried over from the switch [change: {"key":"fee_waiver:kind:business:*:withdrawal","from":{"switch":"business_payout_fee_absorbed","on":'
         || CASE WHEN switch.enabled THEN 'true' ELSE 'false' END
         || '},"to":{"payer":"' || added.payer || '","endsAt":null},"approvedBy":null}]',
       clock_timestamp()
  FROM added, switch;
