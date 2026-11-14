-- Display settings (owner, 14 Nov 2026, #216). Their history is never edited, deleted or truncated
-- (tests opt in).
CREATE TRIGGER display_setting_changes_append_only BEFORE UPDATE OR DELETE ON display_setting_changes
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER display_setting_changes_no_truncate BEFORE TRUNCATE ON display_setting_changes
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
