-- The owner's pricing, 12 Nov 2026: old per-page fee deals (ADR-0014) are capped at the page's plan
-- rate (Free 7%, Pro 5%); a deal below it stays, and fee-free tips already granted stay. Quotes apply
-- the cap themselves (planShareBps), so this only tidies what staff see and records it: a deal at or
-- above 7% can never apply on any plan and is cleared; a Pro page's deal from 5% up to 7% is kept (it
-- applies again if the page returns to Free) and noted. Each page gets one system audit row.
INSERT INTO audit_events (id, staff_user_id, action, permission, subject_type, subject_id, reason, created_at)
SELECT gen_random_uuid(), NULL, 'fee.capped', 'fees.manage', 'profile', p.id::text,
       'Owner''s pricing decision, 12 Nov 2026: per-page fees are capped at the plan''s rate (Free 7%, Pro 5%); this one is at or above every plan''s rate, so the plan''s rate applies [change: {"from":'
         || p.custom_fee_bps || ',"to":null}]',
       clock_timestamp()
  FROM profiles p
 WHERE p.custom_fee_bps >= 700;
--> statement-breakpoint
INSERT INTO audit_events (id, staff_user_id, action, permission, subject_type, subject_id, reason, created_at)
SELECT gen_random_uuid(), NULL, 'fee.capped', 'fees.manage', 'profile', p.id::text,
       'Owner''s pricing decision, 12 Nov 2026: per-page fees are capped at the plan''s rate (Free 7%, Pro 5%); this one is kept, and is charged at Pro''s 5% while the page is on Pro [change: {"from":'
         || p.custom_fee_bps || ',"to":' || p.custom_fee_bps || ',"onPro":500}]',
       clock_timestamp()
  FROM profiles p
 WHERE p.plan = 'pro' AND p.custom_fee_bps >= 500 AND p.custom_fee_bps < 700
   AND NOT EXISTS (
     SELECT 1 FROM audit_events a
      WHERE a.action = 'fee.capped' AND a.subject_type = 'profile' AND a.subject_id = p.id::text);
--> statement-breakpoint
UPDATE profiles SET custom_fee_bps = NULL WHERE custom_fee_bps >= 700;
