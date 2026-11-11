-- Paid Pro (ADR-0015). Prices are history: never edited, deleted or truncated (tests opt in).
CREATE TRIGGER pro_prices_append_only BEFORE UPDATE OR DELETE ON pro_prices
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER pro_prices_no_truncate BEFORE TRUNCATE ON pro_prices
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
--> statement-breakpoint
-- The launch price: ₦2,500 a month (250,000 kobo). Set by the owner, not by a staff member here.
INSERT INTO pro_prices (id, amount_minor, currency, effective_from, set_by, approved_by, reason, created_at)
VALUES ('00000000-0000-4000-8000-000000250000', 250000, 'NGN', now(), NULL, NULL,
  'Owner''s decision, 9 Nov 2026: launch Pro price ₦2,500 a month', now());
--> statement-breakpoint
-- ensureOwnerRole runs only when an owner is granted, so the existing owner gets it here.
INSERT INTO role_permissions (role_id, permission)
SELECT id, 'pro.price' FROM roles WHERE id = 'owner'
ON CONFLICT DO NOTHING;
