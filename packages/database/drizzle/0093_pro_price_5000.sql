-- The owner's pricing, 12 Nov 2026: Pro's default price is ₦5,000 a month (500,000 kobo). Prices are
-- history (0087), so this adds a row after the launch ₦2,500 instead of editing it, with a system audit
-- row like a staff change (pro.price_changed). Months already paid keep their price; staff can still
-- change it in ops. It acts only while the current price is not already ₦5,000, and it lands strictly
-- after every earlier row even when 0087 runs in the same transaction (now() is the same there).
WITH current_price AS (
  SELECT amount_minor FROM pro_prices
   WHERE effective_from <= clock_timestamp()
   ORDER BY effective_from DESC, created_at DESC
   LIMIT 1
), added AS (
  INSERT INTO pro_prices (id, amount_minor, currency, effective_from, set_by, approved_by, reason, created_at)
  SELECT gen_random_uuid(), 500000, 'NGN',
         GREATEST(clock_timestamp(),
                  COALESCE((SELECT max(effective_from) FROM pro_prices), clock_timestamp()) + interval '1 millisecond'),
         NULL, NULL, 'Owner''s pricing decision, 12 Nov 2026: Pro is ₦5,000 a month', clock_timestamp()
   WHERE NOT EXISTS (SELECT 1 FROM current_price WHERE amount_minor = 500000)
  RETURNING id
)
INSERT INTO audit_events (id, staff_user_id, action, permission, subject_type, subject_id, reason, created_at)
SELECT gen_random_uuid(), NULL, 'pro.price_changed', 'pro.price', 'pro_price', added.id::text,
       'Owner''s pricing decision, 12 Nov 2026: Pro is ₦5,000 a month [change: {"from":'
         || COALESCE('"' || (SELECT amount_minor::text FROM current_price) || '"', 'null')
         || ',"to":"500000","approvedBy":null}]',
       clock_timestamp()
  FROM added;
