console.log("DEBUG: Simple Server Starting...");
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Simple Server Works'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`DEBUG: Simple Server Listening on ${PORT}`);
});
