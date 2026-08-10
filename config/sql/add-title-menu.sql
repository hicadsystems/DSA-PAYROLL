-- Adds the "Title" item under the Reference Tables menu and grants it to roles.
-- Run once per payroll-class database (dsa_hicaddata, dsa_hicaddata1, ... dsa_hicaddata5).
-- The sidebar is filtered against menu_items / role_menu_permissions, so without
-- these rows the Title link stays hidden even though the nav markup exists.

SET @reference_id = (SELECT id FROM menu_items WHERE menu_key = 'reference-tables');

INSERT INTO menu_items (menu_key, menu_name, parent_id, menu_order, menu_type)
SELECT 'title', 'Title', @reference_id,
       (SELECT COALESCE(MAX(mi.menu_order), 0) + 1
          FROM menu_items mi WHERE mi.parent_id = @reference_id),
       'item'
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE menu_key = 'title');

-- Grant to the HICAD role (role_id 5). Repeat/adjust for any other roles
-- that should see the section.
INSERT INTO role_menu_permissions (role_id, menu_item_id)
SELECT 5, id FROM menu_items
WHERE menu_key = 'title'
  AND id NOT IN (SELECT menu_item_id FROM role_menu_permissions WHERE role_id = 5);
