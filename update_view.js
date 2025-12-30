const { Client } = require('pg');
require('dotenv').config({ path: 'backend/.env' });

async function updateView() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    try {
        await client.connect();
        console.log('Connected to DB');
        
        await client.query(`
            CREATE OR REPLACE VIEW issues_with_votes AS
            SELECT 
                i.*,
                COALESCE(v_agg.upvotes, 0) AS upvotes,
                COALESCE(v_agg.downvotes, 0) AS downvotes,
                COALESCE(v_agg.net_votes, 0) AS net_votes
            FROM issues i
            LEFT JOIN (
                SELECT 
                    COALESCE(i2.duplicate_of, i2.id) as effective_issue_id,
                    SUM(CASE WHEN v.vote_type = 'upvote' THEN 1 ELSE 0 END) AS upvotes,
                    SUM(CASE WHEN v.vote_type = 'downvote' THEN 1 ELSE 0 END) AS downvotes,
                    SUM(CASE WHEN v.vote_type = 'upvote' THEN 1 WHEN v.vote_type = 'downvote' THEN -1 ELSE 0 END) AS net_votes
                FROM votes v
                JOIN issues i2 ON v.issue_id = i2.id
                GROUP BY COALESCE(i2.duplicate_of, i2.id)
            ) v_agg ON i.id = v_agg.effective_issue_id;
        `);
        console.log('View updated successfully');
    } catch (err) {
        console.error('Error updating view:', err);
    } finally {
        await client.end();
    }
}

updateView();
