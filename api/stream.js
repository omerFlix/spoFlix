const { Readable } = require('node:stream');

const ALLOWED_HOSTS = [
  'audius.co',
  'audius-content.com',
  'altego.net',
  'deezer.com',
  'dzcdn.net',
  'jamendo.com',
  'jamendo.net',
  'monophonic.digital',
  'shakespearetech.com',
  'soundhelix.com'
];

function isAllowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function parseAllowedUrl(value) {
  let url;
  try { url = new URL(value); } catch (error) { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !isAllowedHost(url.hostname)) return null;
  return url;
}

module.exports = async function streamProxy(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    response.status(405).end('Method not allowed');
    return;
  }

  const targetUrl = parseAllowedUrl(request.query.url);
  if (!targetUrl) {
    response.status(400).end('Unsupported audio URL');
    return;
  }

  const range = request.headers.range;
  if (range && !/^bytes=\d*-\d*$/.test(range)) {
    response.status(416).end('Invalid byte range');
    return;
  }

  try {
    let upstream;
    let url = targetUrl;
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      upstream = await fetch(url, {
        method: request.method,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
          ...(range ? { Range: range } : {})
        },
        signal: AbortSignal.timeout(60000)
      });

      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      if (!location || redirects === 4) {
        response.status(502).end('Audio redirect failed');
        return;
      }
      url = parseAllowedUrl(new URL(location, url).href);
      if (!url) {
        response.status(502).end('Unsupported audio redirect');
        return;
      }
    }

    if (!upstream || !upstream.ok && upstream.status !== 206) {
      response.status(upstream?.status || 502).end('Audio stream unavailable');
      return;
    }

    response.status(upstream.status);
    response.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    response.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    response.setHeader('Cache-Control', 'no-store');
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }

    if (request.method === 'HEAD' || !upstream.body) {
      response.end();
      return;
    }
    Readable.fromWeb(upstream.body).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    console.error('Audio stream proxy failed:', error.message);
    if (!response.headersSent) response.status(502).end('Audio stream failed');
    else response.destroy();
  }
};
