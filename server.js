/* ============================================
   SPOFLIX - Yerel Statik Dosya Sunucusu
   Electron uygulaması uygulamayı localhost
   üzerinden servis eder. Böylece fetch,
   CORS ve modern tarayıcı API'leri sorunsuz
   çalışır. Harici bağımlılık YOKTUR.
   ============================================ */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const urlMod = require('url');

const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Tek bir HTTP isteğini işler (statik dosya servisi + range desteği).
 */
function handleRequest(req, res) {
  // CORS - yerel sunucudan yapılan çağrılar için gevşek izin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  let pathname;
  let parsed;
  try {
    parsed = new urlMod.URL(req.url, `http://localhost`);
    pathname = parsed.pathname || '/';
  } catch (e) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // Ses akışı proxy servisi (CORS ve 302 yönlendirmelerini yerel sunucu üzerinden pürüzsüz servis eder)
  if (pathname === '/api/stream') {
    const targetUrl = parsed.searchParams.get('url');
    if (!targetUrl) {
      res.statusCode = 400;
      res.end('Missing url parameter');
      return;
    }
    proxyAudioStream(targetUrl, req, res);
    return;
  }

  if (pathname === '/api/youtube') {
    handleYouTubeSearch(parsed, res);
    return;
  }

  let filePath = path.normalize(path.join(ROOT, pathname));

  // Dizin dışına çıkış engelle (path traversal koruması)
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  resolveFile(filePath, (resolved, stat) => {
    if (!resolved) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    serveFile(req, res, resolved, stat);
  });
}

/**
 * Verilen yolu çözer. Dizinse index.html'e yönlendirir.
 * Dosya yoksa null döndürür.
 */
function resolveFile(filePath, cb) {
  fs.stat(filePath, (err, stat) => {
    if (err) {
      cb(null, null);
      return;
    }
    if (stat.isDirectory()) {
      const idx = path.join(filePath, 'index.html');
      fs.stat(idx, (err2, stat2) => {
        if (err2) { cb(null, null); return; }
        cb(idx, stat2);
      });
      return;
    }
    cb(filePath, stat);
  });
}

/**
 * Dosyayı Range desteğiyle gönderir.
 */
function serveFile(req, res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);

  const total = stat.size;
  const rangeHeader = req.headers && req.headers.range;

  let start = 0;
  let end = total - 1;

  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (m) {
      if (m[1] !== '') start = parseInt(m[1], 10);
      if (m[2] !== '') end = parseInt(m[2], 10);
      if (start === 0 && m[1] === '' && m[2] !== '') {
        // suffix range: last N bytes
        start = Math.max(0, total - parseInt(m[2], 10));
        end = total - 1;
      }
      if (start > end || start >= total) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${total}`);
        res.end();
        return;
      }
      end = Math.min(end, total - 1);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    }
  }

  const length = (end - start) + 1;
  res.setHeader('Content-Length', String(length));
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  let stream;
  try {
    stream = fs.createReadStream(filePath, { start, end });
  } catch (e) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 404;
      res.end('Not Found');
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

/**
 * Sunucuyu verilen portta başlatır.
 * @returns {Promise<string>} Çalışan sunucunun adresi
 */
function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.on('error', reject);
    try {
      server.listen(port, () => {
        resolve({
          url: `http://localhost:${port}`,
          server,
        });
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Harici ses akışlarını yerel sunucu üzerinden yönlendirmeli olarak proxy eder.
 */
function proxyAudioStream(targetUrl, req, res) {
  try {
    const client = targetUrl.startsWith('https:') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
      }
    };
    if (req.headers.range) {
      options.headers.range = req.headers.range;
    }
    const proxyReq = client.get(targetUrl, options, (proxyRes) => {
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        let redirectUrl = proxyRes.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const origin = new URL(targetUrl).origin;
          redirectUrl = new URL(redirectUrl, origin).href;
        }
        proxyAudioStream(redirectUrl, req, res);
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'audio/mpeg');
      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      if (proxyRes.headers['content-range']) {
        res.setHeader('Content-Range', proxyRes.headers['content-range']);
      }
      res.statusCode = proxyRes.statusCode || 200;
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      console.warn('Audio proxy error:', err.message);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end('Proxy Fetch Failed');
      }
    });
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Server Error');
    }
  }
}

module.exports = { startServer };

// Doğrudan komut satırından çalıştırılırsa sunucuyu başlat
if (require.main === module) {
  startServer(process.env.PORT || 45678).then(({ url }) => {
    console.log(`SpoFlix sunucusu çalışıyor: ${url}`);
  });
}

function getYouTubeApiKey() {
  if (process.env.YOUTUBE_DATA_API_KEY) return process.env.YOUTUBE_DATA_API_KEY;
  try {
    const localConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'local-secrets.json'), 'utf8'));
    return localConfig.youtubeDataApiKey || '';
  } catch (e) {
    return '';
  }
}

async function handleYouTubeSearch(parsed, res) {
  const query = (parsed.searchParams.get('q') || '').trim().slice(0, 150);
  const limit = Math.max(1, Math.min(25, Number(parsed.searchParams.get('limit')) || 10));
  const apiKey = getYouTubeApiKey();
  if (!query) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Missing query' }));
    return;
  }
  if (!apiKey) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'YouTube search is not configured' }));
    return;
  }

  try {
    const target = new URL('https://www.googleapis.com/youtube/v3/search');
    target.searchParams.set('part', 'snippet');
    target.searchParams.set('type', 'video');
    target.searchParams.set('maxResults', String(limit));
    target.searchParams.set('q', query);
    target.searchParams.set('key', apiKey);
    target.searchParams.set('videoEmbeddable', 'true');
    target.searchParams.set('videoSyndicated', 'true');
    const upstream = await fetch(target);
    const data = await upstream.json();
    if (!upstream.ok) throw new Error(`YouTube API HTTP ${upstream.status}`);
    const searchItems = (data.items || []).filter((item) => item.id?.videoId);
    const durations = new Map();
    if (searchItems.length) {
      try {
        const detailsTarget = new URL('https://www.googleapis.com/youtube/v3/videos');
        detailsTarget.searchParams.set('part', 'contentDetails');
        detailsTarget.searchParams.set('id', searchItems.map((item) => item.id.videoId).join(','));
        detailsTarget.searchParams.set('key', apiKey);
        const detailsResponse = await fetch(detailsTarget);
        if (detailsResponse.ok) {
          const details = await detailsResponse.json();
          for (const video of details.items || []) {
            const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(video.contentDetails?.duration || '');
            if (match) durations.set(video.id, Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
          }
        } else {
          console.warn('YouTube duration lookup failed:', detailsResponse.status);
        }
      } catch (error) {
        console.warn('YouTube duration lookup failed:', error.message);
      }
    }
    const items = searchItems.map((item) => ({
      id: `youtube_${item.id.videoId}`,
      youtubeId: item.id.videoId,
      name: item.snippet.title,
      artist: item.snippet.channelTitle,
      album: 'YouTube',
      artwork: item.snippet.thumbnails?.high?.url || '',
      artworkSmall: item.snippet.thumbnails?.medium?.url || '',
      previewUrl: '',
      duration: durations.get(item.id.videoId) || 0,
      source: 'youtube',
      isFullSong: true
    }));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=180');
    res.end(JSON.stringify({ items }));
  } catch (error) {
    console.warn('YouTube search failed:', error.message);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'YouTube search failed' }));
  }
}
