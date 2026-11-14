-- Paid Pro (ADR-0015): every page on Pro today was put there by staff, so it keeps Pro as a staff
-- grant. From now on profiles.plan is derived from staff_pro and the paid months.
UPDATE profiles SET staff_pro = true WHERE plan = 'pro';
