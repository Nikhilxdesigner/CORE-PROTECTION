/**
 * Static development server.
 *
 * The game is plain ES modules with no build step, so all it needs is a server
 * that serves files with correct MIME types over http:// (module + getUserMedia
 * both fail on file://).
 *
 * Why not `python -m http.server` or `npx serve`? Two practical reasons:
 *   1. no dependency on anything being installed, and
 *   2. `Cache-Control: no-store`, so an edit is visible on the next reload.
 *      Browsers otherwise apply heuristic freshness to module scripts and quietly
 *      run yesterday's code, which is a genuinely confusing way to lose an hour.
 *
 * Usage:  node tools/dev-server.mjs [port]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8099);
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8'
};

/** Resolve a request path to a file inside ROOT, or null when it escapes. */
function safePath(urlPath) {
    const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
    const relative = normalize(decoded).replace(/^([/\\])+/, '');
    const absolute = join(ROOT, relative);
    if (!absolute.startsWith(ROOT)) return null;
    return absolute;
}

const server = createServer(async (req, res) => {
    const started = Date.now();
    let target = safePath(req.url || '/');

    if (!target) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    try {
        let info = await stat(target).catch(() => null);
        if (info?.isDirectory()) {
            target = join(target, 'index.html');
            info = await stat(target).catch(() => null);
        }
        if (!info?.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end(`404 ${req.url}`);
            console.log(`404 ${req.method} ${req.url}`);
            return;
        }

        res.writeHead(200, {
            'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
            'Content-Length': info.size,
            // No caching at all: always run the code that is on disk right now.
            'Cache-Control': 'no-store, must-revalidate',
            'Last-Modified': info.mtime.toUTCString()
        });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        const stream = createReadStream(target);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        if (process.env.QUIET !== '1') {
            console.log(`200 ${req.method} ${req.url} (${info.size}B, ${Date.now() - started}ms)`);
        }
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
        console.error(`500 ${req.method} ${req.url}:`, err.message);
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Camera Defense: Overdrive -> http://${HOST}:${PORT}/`);
    console.log('Serve only. Open the URL, or add ?demo=1 to play without a camera.');
});
