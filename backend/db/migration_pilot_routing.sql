-- Pilot routing: FCC, EDSA and SLRSA.
--
-- The pilot runs with three institutions, so their category mappings need to be
-- reproducible rather than clicked in by hand on each deployment. This sets the
-- proposed mapping; any of it can be changed in Admin > Users > Categories
-- without touching the database, and the MDAs are expected to confirm their own
-- remit before go-live.
--
-- One correction is included: SLRSA was mapped to Drainage & Flooding, which is
-- not a road safety function. Drainage in Freetown sits with FCC. SLRSA takes
-- road safety, traffic management and public transport instead.
--
-- Safe to re-run.

DO $$
DECLARE
    grp_fcc INTEGER;
    grp_edsa INTEGER;
    grp_slrsa INTEGER;
BEGIN
    SELECT id INTO grp_fcc   FROM groups WHERE name = 'FCC';
    SELECT id INTO grp_edsa  FROM groups WHERE name = 'EDSA';
    SELECT id INTO grp_slrsa FROM groups WHERE name = 'SLRSA';

    -- Withdraw the incorrect drainage assignment before adding the new ones, so
    -- re-running does not leave SLRSA holding a category it never owned.
    DELETE FROM category_groups
    WHERE group_id = grp_slrsa
      AND category_id IN (SELECT id FROM categories WHERE name = 'Drainage & Flooding');

    -- Freetown City Council: the municipal services a resident sees on the street.
    INSERT INTO category_groups (category_id, group_id, role)
    SELECT c.id, grp_fcc, 'lead' FROM categories c
    WHERE c.name IN ('Waste Management', 'Sewage & Sanitation', 'Drainage & Flooding',
                     'Public Space Maintenance', 'Market Operations', 'Streetlights')
      AND grp_fcc IS NOT NULL
    ON CONFLICT DO NOTHING;

    -- EDSA owns supply; it is alerted on streetlights because a dark street is
    -- often a supply fault rather than a council one, but FCC leads the fix.
    INSERT INTO category_groups (category_id, group_id, role)
    SELECT c.id, grp_edsa, 'lead' FROM categories c
    WHERE c.name = 'Electricity & Power Supply' AND grp_edsa IS NOT NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO category_groups (category_id, group_id, role)
    SELECT c.id, grp_edsa, 'support' FROM categories c
    WHERE c.name = 'Streetlights' AND grp_edsa IS NOT NULL
    ON CONFLICT DO NOTHING;

    -- SLRSA: road safety, not road construction -- SLRA keeps Road Infrastructure.
    INSERT INTO category_groups (category_id, group_id, role)
    SELECT c.id, grp_slrsa, 'lead' FROM categories c
    WHERE c.name IN ('Road Safety', 'Traffic Management', 'Public Transportation')
      AND grp_slrsa IS NOT NULL
    ON CONFLICT DO NOTHING;

    -- Promote the pilot institutions' own categories to lead where an earlier
    -- migration left them as support and no other MDA is competing for them.
    UPDATE category_groups cg
    SET role = 'lead'
    WHERE cg.group_id IN (grp_fcc, grp_edsa, grp_slrsa)
      AND cg.role = 'support'
      AND cg.category_id IN (SELECT id FROM categories WHERE name IN (
            'Waste Management', 'Sewage & Sanitation', 'Drainage & Flooding',
            'Public Space Maintenance', 'Market Operations',
            'Electricity & Power Supply',
            'Road Safety', 'Traffic Management', 'Public Transportation'));
END $$;
