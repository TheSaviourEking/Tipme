-- Feature switches (owner, 14 Nov 2026). A switch's history is never edited, deleted or truncated
-- (tests opt in). The switches themselves are written on each process's first start, not here.
CREATE TRIGGER feature_switch_changes_append_only BEFORE UPDATE OR DELETE ON feature_switch_changes
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER feature_switch_changes_no_truncate BEFORE TRUNCATE ON feature_switch_changes
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
--> statement-breakpoint
-- ensureOwnerRole runs only when an owner is granted, so the existing owner gets it here.
INSERT INTO role_permissions (role_id, permission)
SELECT id, 'switches.manage' FROM roles WHERE id = 'owner'
ON CONFLICT DO NOTHING;
