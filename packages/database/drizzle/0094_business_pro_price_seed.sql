-- Business Pro (plan Task A1): the launch price, ₦7,000 a month (700,000 kobo), plan 'business'.
-- Set by the owner, not by a staff member here. The personal price is not touched.
INSERT INTO pro_prices (id, amount_minor, currency, effective_from, set_by, approved_by, plan, reason, created_at)
VALUES ('00000000-0000-4000-8000-000000700000', 700000, 'NGN', now(), NULL, NULL, 'business',
  'Launch price (owner’s decision, 14 Nov 2026)', now());
