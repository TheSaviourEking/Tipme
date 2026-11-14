-- ensureOwnerRole runs only when an owner is granted, so the existing owner gets announcements.send here
-- (the same as 0098 did for switches.manage). Safe to run twice.
INSERT INTO role_permissions (role_id, permission)
SELECT id, 'announcements.send' FROM roles WHERE id = 'owner'
ON CONFLICT DO NOTHING;
