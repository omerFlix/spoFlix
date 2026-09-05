// api/playlists.js
// Vercel Serverless Function + Vercel KV (Upstash Redis) tabanlı
// paylaşımlı çalma listesi backend'i.
//
// Kurulum:
// 1. Vercel dashboard -> Storage -> Create Database -> KV (Upstash Redis)
// 2. Projene "Connect" et (otomatik olarak KV_REST_API_URL ve
//    KV_REST_API_TOKEN env değişkenlerini ekler, ekstra config gerekmez)
// 3. npm i @vercel/kv
// 4. Deploy

import { kv } from '@vercel/kv';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I gibi karışan karakterler çıkarıldı

function generateShareCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function playlistKey(code) {
  return `playlist:${code}`;
}

function sanitizeTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const id = String(track.id ?? '').slice(0, 200);
  if (!id) return null;
  return {
    id,
    name: String(track.name ?? 'Bilinmeyen Şarkı').slice(0, 300),
    artist: String(track.artist ?? 'Bilinmeyen Sanatçı').slice(0, 300),
    album: String(track.album ?? '').slice(0, 300),
    artwork: String(track.artwork ?? '').slice(0, 800),
    artworkSmall: String(track.artworkSmall ?? '').slice(0, 800),
    previewUrl: String(track.previewUrl ?? '').slice(0, 800),
    duration: Number.isFinite(track.duration) ? track.duration : 0,
    isFullSong: Boolean(track.isFullSong),
  };
}

function sanitizeUserName(name) {
  return String(name ?? 'Misafir').trim().slice(0, 60) || 'Misafir';
}

async function indexPlaylistForUser(userName, code) {
  const key = `user_playlists:${userName}`;
  const codes = (await kv.get(key)) || [];
  if (!codes.includes(code)) {
    codes.push(code);
    await kv.set(key, codes);
  }
}

async function handleCreate(req, res) {
  const { name, ownerName, tracks } = req.body || {};
  const playlistName = String(name ?? 'Yeni Çalma Listesi').trim().slice(0, 120) || 'Yeni Çalma Listesi';
  const owner = sanitizeUserName(ownerName);
  const cleanTracks = Array.isArray(tracks) ? tracks.map(sanitizeTrack).filter(Boolean).slice(0, 500) : [];

  let code = generateShareCode();
  // Çok düşük olasılıklı çarpışmayı önlemek için birkaç deneme
  for (let attempt = 0; attempt < 5; attempt++) {
    const exists = await kv.get(playlistKey(code));
    if (!exists) break;
    code = generateShareCode();
  }

  const playlist = {
    code,
    name: playlistName,
    ownerName: owner,
    tracks: cleanTracks,
    members: [owner],
    likes: {}, // { userName: true }
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await kv.set(playlistKey(code), playlist);
  await indexPlaylistForUser(owner, code);
  return res.status(201).json({ playlist });
}

async function handleGet(req, res) {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code gerekli' });
  const playlist = await kv.get(playlistKey(String(code).toUpperCase()));
  if (!playlist) return res.status(404).json({ error: 'Çalma listesi bulunamadı' });
  return res.status(200).json({ playlist });
}

async function handleJoin(req, res) {
  const { code, userName } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code gerekli' });
  const key = playlistKey(String(code).toUpperCase());
  const playlist = await kv.get(key);
  if (!playlist) return res.status(404).json({ error: 'Çalma listesi bulunamadı' });

  const user = sanitizeUserName(userName);
  if (!playlist.members.includes(user)) {
    playlist.members.push(user);
    playlist.updatedAt = Date.now();
    await kv.set(key, playlist);
  }
  await indexPlaylistForUser(user, playlist.code);
  return res.status(200).json({ playlist });
}

async function handleAddTrack(req, res) {
  const { code, track, userName } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code gerekli' });
  const key = playlistKey(String(code).toUpperCase());
  const playlist = await kv.get(key);
  if (!playlist) return res.status(404).json({ error: 'Çalma listesi bulunamadı' });

  const clean = sanitizeTrack(track);
  if (!clean) return res.status(400).json({ error: 'Geçersiz şarkı verisi' });
  if (playlist.tracks.length >= 500) return res.status(400).json({ error: 'Çalma listesi dolu (500 şarkı sınırı)' });

  if (!playlist.tracks.some((t) => t.id === clean.id)) {
    playlist.tracks.push(clean);
    playlist.updatedAt = Date.now();
    await kv.set(key, playlist);
  }
  return res.status(200).json({ playlist });
}

async function handleRemoveTrack(req, res) {
  const { code, trackId } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code gerekli' });
  const key = playlistKey(String(code).toUpperCase());
  const playlist = await kv.get(key);
  if (!playlist) return res.status(404).json({ error: 'Çalma listesi bulunamadı' });

  playlist.tracks = playlist.tracks.filter((t) => t.id !== String(trackId));
  playlist.updatedAt = Date.now();
  await kv.set(key, playlist);
  return res.status(200).json({ playlist });
}

async function handleLike(req, res) {
  const { code, userName, liked } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code gerekli' });
  const key = playlistKey(String(code).toUpperCase());
  const playlist = await kv.get(key);
  if (!playlist) return res.status(404).json({ error: 'Çalma listesi bulunamadı' });

  const user = sanitizeUserName(userName);
  if (!playlist.likes) playlist.likes = {};
  if (liked) playlist.likes[user] = true;
  else delete playlist.likes[user];
  playlist.updatedAt = Date.now();
  await kv.set(key, playlist);
  return res.status(200).json({ playlist });
}

async function handleListForUser(req, res) {
  // Bir kullanıcının üye olduğu tüm paylaşımlı listeleri döndürür.
  // Basit yaklaşım: kullanıcı adına göre indeks tutuyoruz.
  const { userName } = req.query;
  if (!userName) return res.status(400).json({ error: 'userName gerekli' });
  const user = sanitizeUserName(userName);
  const codes = (await kv.get(`user_playlists:${user}`)) || [];
  const playlists = [];
  for (const code of codes) {
    const p = await kv.get(playlistKey(code));
    if (p) playlists.push(p);
  }
  return res.status(200).json({ playlists });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = req.query.action || (req.body && req.body.action);

    if (req.method === 'GET' && action === 'get') return await handleGet(req, res);
    if (req.method === 'GET' && action === 'list') return await handleListForUser(req, res);
    if (req.method === 'POST' && action === 'create') return await handleCreate(req, res);
    if (req.method === 'POST' && action === 'join') return await handleJoin(req, res);
    if (req.method === 'POST' && action === 'addTrack') return await handleAddTrack(req, res);
    if (req.method === 'POST' && action === 'removeTrack') return await handleRemoveTrack(req, res);
    if (req.method === 'POST' && action === 'like') return await handleLike(req, res);

    return res.status(400).json({ error: 'Bilinmeyen action' });
  } catch (err) {
    console.error('playlists api error:', err);
    return res.status(500).json({ error: 'Sunucu hatası', detail: String(err.message || err) });
  }
}
