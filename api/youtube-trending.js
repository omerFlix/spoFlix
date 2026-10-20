function durationInSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value || '');
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Math.round(Number(match[3] || 0));
}

module.exports = async function youtubeTrending(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const limit = Math.max(1, Math.min(25, Number(request.query.limit) || 25));
  const apiKey = process.env.YOUTUBE_DATA_API_KEY;
  if (!apiKey) {
    response.status(503).json({ error: 'YouTube trends are not configured' });
    return;
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('regionCode', 'TR');
  url.searchParams.set('videoCategoryId', '10');
  url.searchParams.set('maxResults', String(limit));
  url.searchParams.set('key', apiKey);

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('YouTube trending API returned an error:', upstream.status);
      response.status(502).json({ error: 'YouTube trend list failed' });
      return;
    }

    const items = (data.items || [])
      .filter((video) => video.id && video.snippet?.liveBroadcastContent !== 'live' && video.snippet?.liveBroadcastContent !== 'upcoming')
      .map((video) => {
        const thumbnails = video.snippet?.thumbnails || {};
        const artwork = thumbnails.maxres?.url || thumbnails.high?.url || thumbnails.medium?.url || '';
        const artworkSmall = thumbnails.medium?.url || thumbnails.default?.url || artwork;
        return {
          id: `youtube_${video.id}`,
          youtubeId: video.id,
          name: video.snippet?.title || 'Bilinmeyen Video',
          artist: video.snippet?.channelTitle || 'YouTube Kanalı',
          album: 'YouTube Türkiye Trendleri',
          artwork,
          artworkSmall,
          previewUrl: '',
          duration: durationInSeconds(video.contentDetails?.duration),
          source: 'youtube',
          isFullSong: true
        };
      });

    response.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=1800');
    response.status(200).json({ items });
  } catch (error) {
    console.error('YouTube trending request failed:', error.message);
    response.status(502).json({ error: 'YouTube trend list failed' });
  }
};
