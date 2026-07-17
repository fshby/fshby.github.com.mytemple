const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    console.log('Request received:', req.url);
    if (req.url === '/version.json') {
        const versionPath = path.join(__dirname, 'version.json');
        fs.readFile(versionPath, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        });
    } else if (req.url === '/MyTempleKnowledge_Setup.exe') {
        const exePath = path.join(__dirname, 'dist', 'MyTempleKnowledge_Setup.exe');
        fs.readFile(exePath, (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File not found' }));
                return;
            }
            res.writeHead(200, { 
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': 'attachment; filename=MyTempleKnowledge_Setup.exe'
            });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(8080, () => {
    console.log('Test server running on http://localhost:8080');
});
