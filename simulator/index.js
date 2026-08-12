const { createServer, PORT } = require('./server');

if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: Simulator cannot run in production mode. Set NODE_ENV=development or leave it unset.');
    process.exit(1);
}

createServer().then(({ app }) => {
    app.listen(PORT, () => {
        console.log(`\n  Fixam WhatsApp Simulator running at http://localhost:${PORT}\n`);
    });
}).catch((err) => {
    console.error('Failed to start simulator:', err);
    process.exit(1);
});
