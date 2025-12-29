const fs = require('fs');

const categories = [
    { name: 'Water', templates: ['Burst pipe in {city}', 'Water shortage at {area}', 'Contaminated well in {area}', 'Leaking valve on {road}'] },
    { name: 'Road', templates: ['Deep pothole on {road}', 'Broken culvert near {area}', 'Erosion damage at {city} bypass', 'Missing manhole cover on {road}'] },
    { name: 'Waste', templates: ['Illegal dump site in {area}', 'Uncollected garbage at {city} market', 'Burning trash near school in {area}', 'Overfilled bins on {road}'] },
    { name: 'Electricity', templates: ['Fallen power line on {road}', 'Transformers sparking in {area}', 'Street lights out at {city}', 'Illegal connection suspected in {area}'] },
    { name: 'Health', templates: ['Overflowing sewage in {area}', 'Medical waste found near {road}', 'Stagnant water breeding mosquitoes at {area}', 'Public toilet in disrepair in {city}'] }
];

const cities = [
    { name: 'Freetown', lat: 8.48, lng: -13.23 },
    { name: 'Bo', lat: 7.96, lng: -11.74 },
    { name: 'Kenema', lat: 7.88, lng: -11.19 },
    { name: 'Makeni', lat: 8.88, lng: -12.04 },
    { name: 'Koidu', lat: 8.64, lng: -10.97 },
    { name: 'Lunsar', lat: 8.68, lng: -12.53 },
    { name: 'Port Loko', lat: 8.76, lng: -12.78 },
    { name: 'Waterloo', lat: 8.34, lng: -13.07 }
];

const roads = ['Jomo Kenyatta Rd', 'Siaka Stevens St', 'Wilkinson Rd', 'Bai Bureh Rd', 'Main Highway', 'Market St', 'Hospital Rd', 'King Harman Rd'];
const areas = ['East End', 'West End', 'Central Central', 'Mountain View', 'Lowcost Housing', 'Fisheries', 'Reservation Area'];

const statuses = ['critical', 'progress', 'fixed', 'acknowledged'];

function randomDate(start, end) {
    return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function formatDate(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function generateTicketId(index) {
    return `FIX${String(index + 1).padStart(7, '0')}`;
}

const userNames = [
    'Mohamed', 'Alhaji', 'Sorie', 'Ibrahim', 'Abdul', 'Sheku', 'Amadu', 'Saidu', 'Abu', 'Musa',
    'Fatmata', 'Mariama', 'Aminata', 'Isatu', 'Hawa', 'Zainab', 'Kadiatu', 'Adama', 'Mabinty', 'Sia',
    'Koroma', 'Kamara', 'Sesay', 'Bangura', 'Conteh', 'Turay', 'Jalloh', 'Mansaray', 'Kargbo', 'Sillah',
    'Kallon', 'Lamin', 'Bunjun', 'Fofanah', 'Tarawallie', 'Sheriff', 'Gbla', 'Dumbuya', 'Carew', 'Mason'
];

function generateMockData() {
    let sql = `-- Extended Mock Data Generated on ${new Date().toISOString()}\n\n`;

    // 1. Users
    sql += `-- Insert Mock Users (50 users + 1 admin)\n`;
    sql += `INSERT INTO users (phone_number, name, role_id, password, created_at) VALUES\n`;
    const users = [];
    
    // Default Admin
    const adminPhone = '000';
    const adminPassHash = '00dc290f5213798bac46b374885e2b8a677f4c7fbdd645088737951fb2b8a677f4c7fb'; // Hash of 'admin' salt '000'
    sql += `('${adminPhone}', 'System Admin', (SELECT id FROM roles WHERE name = 'Admin'), '${adminPassHash}', '2025-01-01 00:00:00'),\n`;
    users.push({ id: 1, name: 'System Admin', phone: adminPhone });

    for (let i = 0; i < 50; i++) {
        const firstName = userNames[Math.floor(Math.random() * 20)];
        const lastName = userNames[20 + Math.floor(Math.random() * 20)];
        const name = `${firstName} ${lastName}`;
        const phone = `232${Math.floor(700000000 + Math.random() * 99999999)}`;
        const date = randomDate(new Date('2025-01-01'), new Date('2025-09-30'));
        users.push({ id: i + 2, name, phone }); // Offset by 2 because 000 is ID 1 (assuming serial starts at 1)
        sql += `('${phone}', '${name}', (SELECT id FROM roles WHERE name = 'User'), null, '${formatDate(date)}')${i === 49 ? ';' : ','}\n`;
    }
    sql += `\n`;

    // 2. Issues
    sql += `-- Insert Mock Issues (200 issues)\n`;
    sql += `INSERT INTO issues (ticket_id, title, category, status, lat, lng, description, image_url, reported_by, reported_on, created_at) VALUES\n`;
    const issues = [];
    const startDate = new Date('2025-10-01');
    const endDate = new Date('2025-12-25');

    for (let i = 0; i < 200; i++) {
        const category = categories[Math.floor(Math.random() * categories.length)];
        const city = cities[Math.floor(Math.random() * cities.length)];
        const road = roads[Math.floor(Math.random() * roads.length)];
        const area = areas[Math.floor(Math.random() * areas.length)];
        
        const title = category.templates[Math.floor(Math.random() * category.templates.length)]
            .replace('{city}', city.name)
            .replace('{road}', road)
            .replace('{area}', area);
        
        const status = statuses[Math.floor(Math.random() * statuses.length)];
        const lat = city.lat + (Math.random() - 0.5) * 0.1;
        const lng = city.lng + (Math.random() - 0.5) * 0.1;
        const reportedBy = users[Math.floor(Math.random() * users.length)].id;
        const date = randomDate(startDate, endDate);
        const ticketId = generateTicketId(i);
        const desc = `Automatically reported via WhatsApp. Requires investigation at ${title}.`;
        const imageUrl = `https://picsum.photos/seed/${ticketId}/400/300`;

        issues.push({ id: i + 1, date });
        sql += `('${ticketId}', '${title.replace(/'/g, "''")}', '${category.name}', '${status}', ${lat.toFixed(6)}, ${lng.toFixed(6)}, '${desc.replace(/'/g, "''")}', '${imageUrl}', ${reportedBy}, '${formatDate(date)}', '${formatDate(date)}')${i === 199 ? ';' : ','}\n`;
    }
    sql += `\n`;

    // 3. Votes
    sql += `-- Insert random votes\n`;
    sql += `INSERT INTO votes (issue_id, user_id, vote_type, created_at) VALUES\n`;
    const votes = [];
    for (let i = 0; i < 400; i++) { // Generate 400 random votes
        const issueId = Math.floor(Math.random() * 200) + 1;
        const userId = Math.floor(Math.random() * 50) + 1;
        const voteType = Math.random() > 0.1 ? 'upvote' : 'downvote';
        const issueDate = issues[issueId - 1].date;
        const voteDate = randomDate(issueDate, new Date('2025-12-31'));
        
        // Prevent duplicate votes for the same user/issue in this script
        const key = `${issueId}-${userId}`;
        if (!votes.find(v => v.key === key)) {
            votes.push({ key, sql: `(${issueId}, ${userId}, '${voteType}', '${formatDate(voteDate)}')` });
        }
    }
    sql += votes.map((v, i) => v.sql + (i === votes.length - 1 ? ';' : ',')).join('\n');
    sql += `\n\n`;

    // 4. Tracker Logs
    sql += `-- Insert tracker logs (at least one per issue)\n`;
    sql += `INSERT INTO issue_tracker (issue_id, action, description, performed_by, created_at) VALUES\n`;
    const trackers = [];
    for (let i = 0; i < 200; i++) {
        const issueId = i + 1;
        const issueDate = issues[i].date;
        trackers.push(`(${issueId}, 'reported', 'Citizen reported issue', null, '${formatDate(issueDate)}')`);
        
        // Maybe some follow up actions
        if (Math.random() > 0.5) {
            const followUpDate = randomDate(issueDate, new Date(issueDate.getTime() + 86400000 * 2)); // 2 days later
            trackers.push(`(${issueId}, 'acknowledged', 'System received report', null, '${formatDate(followUpDate)}')`);
        }
    }
    sql += trackers.join(',\n') + ';';

    return sql;
}

const mockSql = generateMockData();
fs.writeFileSync('c:/Users/kenne/Documents/KVSK/MaxCIT/Projects/FIXAM/Codebase/backend/db/mock_data.sql', mockSql);
console.log('Successfully expanded mock_data.sql');
