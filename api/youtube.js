module.exports = async function youtubeSearch(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const query = String(request.query.q || '').trim().slice(0, 150);
  const limit = Math.max(1, Math.min(25, Number(request.query.limit) || 10));
  const apiKey = process.env.YOUTUBE_DATA_API_KEY;
  if (!query) {
    response.status(400).json({ error: 'Missing query' });
    return;
  }
  if (!apiKey) {
    response.status(503).json({ error: 'YouTube search is not configured' });
    return;
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', String(limit));
  url.searchParams.set('q', query);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('videoSyndicated', 'true');

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('YouTube API returned an error:', upstream.status);
      response.status(502).json({ error: 'YouTube search failed' });
      return;
    }
    const items = (data.items || []).filter((item) => item.id?.videoId).map((item) => ({
      id: `youtube_${item.id.videoId}`,
      youtubeId: item.id.videoId,
      name: item.snippet.title,
      artist: item.snippet.channelTitle,
      album: 'YouTube',
      artwork: item.snippet.thumbnails?.high?.url || '',
      artworkSmall: item.snippet.thumbnails?.medium?.url || '',
      previewUrl: '',
      duration: 0,
      isFullSong: true
    }));
    response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=180, stale-while-revalidate=300');
    response.status(200).json({ items });
  } catch (error) {
    console.error('YouTube search request failed:', error.message);
    response.status(502).json({ error: 'YouTube search failed' });
  }
};
