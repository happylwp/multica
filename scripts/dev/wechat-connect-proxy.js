#!/usr/bin/env node
// Minimal CONNECT tunnel: HTTPS CONNECT only, bidirectional pipe, no request
// logging. Host-native TCP egress so WeChat does not score Docker Desktop's
// data-plane stack. Verified sibling: /tmp/connect-proxy.js
const net = require('net');

const listenHost = process.env.MULTICA_WECHAT_PROXY_LISTEN || '0.0.0.0';
const listenPort = Number(process.env.MULTICA_WECHAT_PROXY_PORT || 18081);

const server = net.createServer((client) => {
  client.once('data', (buf) => {
    const head = buf.toString('latin1');
    const m = head.match(/^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]/);
    if (!m) {
      client.end();
      return;
    }
    const upstream = net.connect({ host: m[1], port: +m[2] }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('error', () => client.end());
  });
  client.on('error', () => {});
});

server.listen(listenPort, listenHost, () => {
  console.log(`proxy on ${listenHost}:${listenPort}`);
});
