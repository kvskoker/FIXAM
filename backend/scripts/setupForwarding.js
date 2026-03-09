const { Pool } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'fixam',
    password: process.env.DB_PASSWORD || 'postgres',
    port: process.env.DB_PORT || 5432,
});

async function setup() {
    try {
        console.log('--- Setting up Automated Forwarding logic ---');

        // 1. Create Groups
        await pool.query(`
            INSERT INTO groups (name, description) VALUES 
            ('National Fire Force', 'Responsible for fire response and emergency operations'),
            ('Hospital Ambulance Service', 'Responsible for road accident response and medical emergencies')
            ON CONFLICT (name) DO NOTHING
        `);

        // 2. Map Categories to Groups
        await pool.query(`
            DO $$
            DECLARE
                cat_fire INT;
                cat_road_safety INT;
                grp_fire_force INT;
                grp_ambulance INT;
            BEGIN
                SELECT id INTO cat_fire FROM categories WHERE name = 'Fire Services';
                SELECT id INTO cat_road_safety FROM categories WHERE name = 'Road Safety';
                
                SELECT id INTO grp_fire_force FROM groups WHERE name = 'National Fire Force';
                SELECT id INTO grp_ambulance FROM groups WHERE name = 'Hospital Ambulance Service';

                -- Map Fire Services to Fire Force
                IF cat_fire IS NOT NULL AND grp_fire_force IS NOT NULL THEN
                    INSERT INTO category_groups (category_id, group_id) 
                    VALUES (cat_fire, grp_fire_force) ON CONFLICT DO NOTHING;
                END IF;

                -- Map Road Safety to Ambulance
                IF cat_road_safety IS NOT NULL AND grp_ambulance IS NOT NULL THEN
                    INSERT INTO category_groups (category_id, group_id) 
                    VALUES (cat_road_safety, grp_ambulance) ON CONFLICT DO NOTHING;
                END IF;
            END $$;
        `);

        // 3. Add Dummy Operation Members for testing (Optional but helpful)
        // Check if role 'Operation' exists (it should from init_db.sql)
        const opRoleResult = await pool.query("SELECT id FROM roles WHERE name = 'Operation'");
        const opRoleId = opRoleResult.rows[0]?.id;

        if (opRoleId) {
             // Add representative members
             // We'll use some placeholders. In a real system, these would be the phone numbers of the ops team.
             const staff = [
                 { name: 'Fire Ops Dispatch', phone: '232112', group: 'National Fire Force' },
                 { name: 'Paramedic Team 1', phone: '232911', group: 'Hospital Ambulance Service' }
             ];

             for (const s of staff) {
                 const userRes = await pool.query(
                     "INSERT INTO users (phone_number, name, role_id) VALUES ($1, $2, $3) ON CONFLICT (phone_number) DO UPDATE SET name = EXCLUDED.name RETURNING id",
                     [s.phone, s.name, opRoleId]
                 );
                 const userId = userRes.rows[0].id;
                 
                 const grpRes = await pool.query("SELECT id FROM groups WHERE name = $1", [s.group]);
                 const groupId = grpRes.rows[0]?.id;

                 if (groupId) {
                     await pool.query(
                         "INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                         [userId, groupId]
                     );
                 }
             }
        }

        console.log('✅ Automated Forwarding setup complete!');
    } catch (err) {
        console.error('❌ Error setting up forwarding:', err);
    } finally {
        await pool.end();
    }
}

setup();
