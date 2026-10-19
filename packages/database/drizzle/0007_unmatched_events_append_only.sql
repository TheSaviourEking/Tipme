-- Unmatched provider events are evidence: never edited, deleted or truncated.
CREATE TRIGGER unmatched_provider_events_append_only BEFORE UPDATE OR DELETE ON unmatched_provider_events
  FOR EACH ROW EXECUTE FUNCTION tipme_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER unmatched_provider_events_no_truncate BEFORE TRUNCATE ON unmatched_provider_events
  FOR EACH STATEMENT EXECUTE FUNCTION tipme_forbid_truncate();
