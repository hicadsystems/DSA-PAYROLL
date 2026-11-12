-- Adds "Monthly Allowance Upload" under the Data Input menu and grants it to roles.
-- menu_items / role_menu_permissions are master tables: run once against the
-- master DB (dsa_hicaddata). Safe to re-run.
-- The sidebar is filtered against these rows, so without them the link stays
-- hidden even though the nav markup exists in dashboard.html.

SET @data_entry_id = (SELECT id FROM menu_items WHERE menu_key = 'data-entry');

INSERT INTO menu_items (menu_key, menu_name, parent_id, menu_order, menu_type)
SELECT 'monthly-allowance-upload', 'Monthly Allowance Upload', @data_entry_id,
       (SELECT COALESCE(MAX(mi.menu_order), 0) + 1
          FROM menu_items mi WHERE mi.parent_id = @data_entry_id),
       'item'
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE menu_key = 'monthly-allowance-upload');

-- Grant to HICAD (5) and MANAGER (4). Add other role ids if they should see it.
INSERT INTO role_menu_permissions (role_id, menu_item_id)
SELECT r.role_id, mi.id
  FROM menu_items mi
  JOIN (SELECT 5 AS role_id UNION ALL SELECT 4) r
 WHERE mi.menu_key = 'monthly-allowance-upload'
   AND NOT EXISTS (
         SELECT 1 FROM role_menu_permissions p
          WHERE p.role_id = r.role_id AND p.menu_item_id = mi.id
       );
