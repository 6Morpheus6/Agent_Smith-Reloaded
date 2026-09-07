const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const netGuard = require('../src/shared/netGuard.js');

const WEB_PORT = 3000;
// This standalone proxy is unauthenticated, so restrict targets to loopback by
// default (the local LLM server). Set XK_LLM_ORIGIN to also allow a specific
// remote LLM origin, e.g. http://192.168.1.50:1234
const LLM_ORIGIN = process.env.XK_LLM_ORIGIN || 'http://127.0.0.1:1234';

let remoteUrl = null;
async function startCloudflareTunnel() {
    const cfPath = path.join(__dirname, '..', 'cloudflared');
    const platform = process.platform;
    const arch = process.arch;
    
    let downloadUrl = "";
    if (platform === 'linux' && arch === 'x64') {
        downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
    }

    if (!fs.existsSync(cfPath) && downloadUrl) {
        console.log('Downloading cloudflared for remote hosting...');
        try {
            if (platform === 'linux') {
                execSync(`wget -O "${cfPath}" "${downloadUrl}"`);
                fs.chmodSync(cfPath, 0o755);
            }
            console.log('cloudflared downloaded successfully.');
        } catch (err) {
            console.error('Failed to download cloudflared:', err);
            return;
        }
    }

    if (fs.existsSync(cfPath)) {
        console.log('Starting Cloudflare Tunnel...');
        const cfProcess = spawn(cfPath, ['tunnel', '--url', `http://localhost:${WEB_PORT}`]);
        
        cfProcess.stderr.on('data', (data) => {
            const output = data.toString();
            const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (match && !remoteUrl) {
                remoteUrl = match[0];
                console.log('\n=========================================');
                console.log(' Remote Access URL: ' + remoteUrl);
                console.log('=========================================\n');
            }
        });

        cfProcess.on('close', (code) => {
            console.log(`cloudflared process exited with code ${code}`);
            remoteUrl = null;
        });
    }
}

const webServer = http.createServer((req, res) => {
    // CORS Headers for Mobile Web Mode
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-target-url');
    if (req.method === 'OPTIONS') return res.end();

    const url = req.url.split('?')[0];

    // API Proxy for Ollama and LM Studio (Solves CORS and localhost binding issues)
    if (url.startsWith('/api/proxy/')) {
        const targetUrl = req.headers['x-target-url'];
        if (!targetUrl) {
            res.writeHead(400); return res.end('Missing x-target-url header');
        }
        const parsed = netGuard.validateProxyTarget(targetUrl, LLM_ORIGIN);
        if (!parsed) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Proxy target not allowed (loopback / configured LLM origin only).' }));
        }
        try {
            const transport = parsed.protocol === 'https:' ? https : http;
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: req.method,
                headers: { ...req.headers, host: parsed.host }
            };

            delete options.headers['origin'];
            delete options.headers['referer'];
            delete options.headers['x-target-url'];
            delete options.headers['accept-encoding'];
            delete options.headers['authorization'];
            delete options.headers['cookie'];
            
            const proxyReq = transport.request(options, (proxyRes) => {
                // Merge target headers with our required CORS headers
                const mergedHeaders = { ...proxyRes.headers };
                mergedHeaders['Access-Control-Allow-Origin'] = '*';
                // Remove some headers that might conflict with the browser's security model
                delete mergedHeaders['content-security-policy'];
                delete mergedHeaders['x-frame-options'];

                res.writeHead(proxyRes.statusCode, mergedHeaders);
                proxyRes.pipe(res);
            });
            
            proxyReq.on('error', e => {
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                }
                res.end(JSON.stringify({ error: 'Proxy failed to connect: ' + e.message }));
            });
            
            req.pipe(proxyReq);
        } catch (e) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            }
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
});

webServer.listen(WEB_PORT, '0.0.0.0', () => {
    console.log('Standalone Web Interface hosted at: http://0.0.0.0:' + WEB_PORT);
    startCloudflareTunnel().catch(console.error);
});
