/**
 * WS upgrade handler. Routes /lobby/<id> upgrades to the right runner
 * by looking up the matchmaker's record. Preserves the query string
 * so auth params survive the proxy hop.
 */

import type { Server as HttpServer } from 'http';
import httpProxy from 'http-proxy';
import type { Matchmaker } from './Matchmaker';

export function attachWsProxy(server: HttpServer, matchmaker: Matchmaker): void {
  const proxy = httpProxy.createProxyServer({ ws: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const m = url.pathname.match(/^\/lobby\/([^/]+)$/);
    if (!m) { socket.destroy(); return; }

    const record = matchmaker.lobbies.get(m[1]);
    if (!record) { socket.destroy(); return; }

    // Rewrite path to '/' but keep the query string (auth params).
    req.url = '/' + url.search;

    proxy.ws(req, socket, head, {
      target:       record.internalWsUrl.replace(/^ws:/, 'http:'),
      changeOrigin: true,
    }, (err) => {
      console.error('[proxy] ws upgrade failed:', err.message);
      socket.destroy();
    });
  });
}