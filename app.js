/* ============================================
   SPOFLIX - Premium Music Streaming App
   ============================================ */

// ── State ──
const state = {
  currentView: 'home', currentTrack: null, queue: [], queueIndex: -1,
  isPlaying: false, isShuffle: false, repeatMode: 0, volume: 0.8, isMuted: false,
  errorCount: 0, maxErrors: 5, trackStartTime: 0, audioReady: false,
  likedSongs: readStoredArray('spoflix_liked'),
  recentlyPlayed: readStoredArray('spoflix_recent'),
  mySongs: [], searchTimeout: null, currentPlaylistTracks: [], youtubeTrendingTracks: [], isSeeking: false,
  playbackMode: 'audio',
  audiusHost: null, currentGenre: null, isLoadingMore: false, loadedTrackIds: new Set(),
  playToken: 0,
  lyricLines: [], lyricTrackId: null, activeLyricIndex: -1, lyricRequestId: 0, lyricOffsets: {},
  audioMode: localStorage.getItem('spoflix_audio_mode') || 'normal',
  isBoosted: localStorage.getItem('spoflix_boost') === 'true',
  boostMultiplier: 2.5,
  searchQuery: '',
};

const isTvBrowser = /(SMART-TV|Tizen|Android TV|GoogleTV|BRAVIA|webOS)/i.test(navigator.userAgent || '');

if (!Promise.allSettled) {
  Promise.allSettled = function (values) {
    return Promise.all(Array.from(values, (value) => Promise.resolve(value).then(
      (result) => ({ status: 'fulfilled', value: result }),
      (reason) => ({ status: 'rejected', reason })
    )));
  };
}

function readStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (error) {
    console.warn(`Saved data for ${key} could not be read.`, error);
    return [];
  }
}

// ── IndexedDB ──
let db = null;
const DB_NAME = 'SpoflixDB', DB_VERSION = 1;
function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (e) => reject(e);
    request.onsuccess = (e) => { db = e.target.result; resolve(db); };
    request.onupgradeneeded = (e) => {
      if (!e.target.result.objectStoreNames.contains('songs'))
        e.target.result.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
    };
  });
}
function saveSongToDB(s) { return new Promise((resolve,reject)=>{const t=db.transaction(['songs'],'readwrite'),o=t.objectStore('songs'),r=o.add(s);r.onsuccess=()=>resolve(r.result);r.onerror=e=>reject(e);}); }
function getSongsFromDB() { return new Promise((resolve,reject)=>{const t=db.transaction(['songs'],'readonly'),o=t.objectStore('songs'),r=o.getAll();r.onsuccess=()=>resolve(r.result);r.onerror=e=>reject(e);}); }
function deleteSongFromDB(id) { return new Promise((resolve,reject)=>{const t=db.transaction(['songs'],'readwrite'),o=t.objectStore('songs'),r=o.delete(id);r.onsuccess=()=>resolve();r.onerror=e=>reject(e);}); }

// ── Audio Player & Web Audio API Engine ──
const audio = new Audio();
audio.crossOrigin = 'anonymous';
audio.volume = 1.0; // HTMLMediaElement 1.0 tutulur, tüm ses seviyesi ve boost GainNode üzerinden yönetilir

let audioContext = null;
let audioSource = null;
let subBassFilter = null;
let bassFilter = null;
let trebleFilter = null;
let audioModeGain = null;
let masterGain = null;
let dynamicsCompressor = null;
let audioAnalyser = null;
let audioMotionFrame = null;

// iOS Safari / WebKit Arka Plan Ses Desteği
if ('audioSession' in navigator) {
  try {
    navigator.audioSession.type = 'playback';
  } catch (e) {
    console.warn('audioSession init error:', e);
  }
}

function initAudioEngine() {
  if (audioContext) {
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    return;
  }
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioContext = new AudioCtx();
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    audioSource = audioContext.createMediaElementSource(audio);

    // 1. Sub-bass vuruş filtresi (75 Hz derin bas gücü)
    subBassFilter = audioContext.createBiquadFilter();
    subBassFilter.type = 'peaking';
    subBassFilter.frequency.value = 75;
    subBassFilter.Q.value = 1.3;
    subBassFilter.gain.value = 0;

    // 2. Bas gövdesi filtresi (130 Hz zengin bas)
    bassFilter = audioContext.createBiquadFilter();
    bassFilter.type = 'lowshelf';
    bassFilter.frequency.value = 130;
    bassFilter.gain.value = 0;

    // 3. Tiz filtresi (3400 Hz berraklık)
    trebleFilter = audioContext.createBiquadFilter();
    trebleFilter.type = 'highshelf';
    trebleFilter.frequency.value = 3400;
    trebleFilter.gain.value = 0;

    audioModeGain = audioContext.createGain();
    audioModeGain.gain.value = 1.0;

    masterGain = audioContext.createGain();
    masterGain.gain.value = 1.0;

    // Gerçek Tepe Limiter (Peak Limiter):
    // Eşiği -1.5 dB yaparak basların ve boost'un boğulmasını önler; sadece hoparlör distorsiyonunu engeller.
    dynamicsCompressor = audioContext.createDynamicsCompressor();
    dynamicsCompressor.threshold.value = -1.5;
    dynamicsCompressor.knee.value = 18;
    dynamicsCompressor.ratio.value = 8;
    dynamicsCompressor.attack.value = 0.003;
    dynamicsCompressor.release.value = 0.15;

    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 128;

    // Bağlantı Grafiği:
    // audioSource -> subBassFilter -> bassFilter -> trebleFilter -> audioModeGain -> masterGain -> compressor -> audioAnalyser -> destination
    audioSource.connect(subBassFilter);
    subBassFilter.connect(bassFilter);
    bassFilter.connect(trebleFilter);
    trebleFilter.connect(audioModeGain);
    audioModeGain.connect(masterGain);
    masterGain.connect(dynamicsCompressor);
    dynamicsCompressor.connect(audioAnalyser);
    audioAnalyser.connect(audioContext.destination);

    applyAudioModeSettings();
    applyVolumeSettings();
  } catch (err) {
    console.warn('initAudioEngine error (fallback native audio):', err);
  }
}

function applyAudioModeSettings() {
  const mode = state.audioMode || 'normal';
  let rate = 1.0;

  if (bassFilter && subBassFilter && trebleFilter && audioModeGain) {
    if (mode === 'boost') {
      subBassFilter.gain.value = 4;
      bassFilter.gain.value = 4;
      trebleFilter.gain.value = 3;
      audioModeGain.gain.value = 1.5;
      rate = 1.0;
    } else if (mode === 'bass') {
      subBassFilter.gain.value = 8;   // +8dB derin sub-bass vuruşu
      bassFilter.gain.value = 14;     // +14dB güçlü bas gövdesi
      trebleFilter.gain.value = 1;
      audioModeGain.gain.value = 1.25;
      rate = 1.0;
    } else if (mode === 'nightcore') {
      subBassFilter.gain.value = -2;
      bassFilter.gain.value = -1;
      trebleFilter.gain.value = 4;
      audioModeGain.gain.value = 1.1;
      rate = 1.18;
    } else {
      subBassFilter.gain.value = 0;
      bassFilter.gain.value = 0;
      trebleFilter.gain.value = 0;
      audioModeGain.gain.value = 1.0;
      rate = 1.0;
    }
  }

  audio.playbackRate = rate;
  if (state.playbackMode === 'youtube' && ytPlayer && ytPlayer.setPlaybackRate) {
    ytPlayer.setPlaybackRate(mode === 'nightcore' ? 1.25 : 1);
  }
}

function applyVolumeSettings() {
  initAudioEngine();
  const boost = state.isBoosted ? state.boostMultiplier : 1.0;
  const modeBoost = state.audioMode === 'boost' ? 1.4 : (state.audioMode === 'bass' ? 1.15 : 1.0);
  const effectiveGain = state.isMuted ? 0 : (state.volume * boost * modeBoost);

  // 1. HTML5 Audio (GainNode üzerinden ses yönetimi)
  if (masterGain && audioContext) {
    try {
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }
      masterGain.gain.setTargetAtTime(effectiveGain, audioContext.currentTime, 0.015);
      audio.volume = 1.0;
    } catch (e) {
      audio.volume = Math.min(1.0, state.volume);
    }
  } else {
    audio.volume = Math.min(1.0, state.volume);
  }

  // 2. YouTube Iframe API temel ses düzeyi
  if (ytPlayerReady && ytPlayer && ytPlayer.setVolume) {
    const ytVol = state.isMuted ? 0 : Math.min(100, Math.round(state.volume * 100));
    ytPlayer.setVolume(ytVol);
  }

  // Masaüstü uygulamasında ses ayarlarını yalnızca sınırlandırılmış preload köprüsüne ilet.
  window.spoflixAudio?.setVolumeBoost({ multiplier: effectiveGain, mode: state.audioMode });

  updateVolumeUI();
}

function toggleBoost() {
  initAudioEngine();
  state.isBoosted = !state.isBoosted;
  localStorage.setItem('spoflix_boost', String(state.isBoosted));
  applyVolumeSettings();
  if (state.isBoosted) {
    showToast('Ses Artırma (Boost 🔥) Açıldı! (+%80 Ekstra Güç)');
  } else {
    showToast('Standart Ses Düzeyine Geçildi');
  }
}

function toggleAudioModes() {
  const panel = document.getElementById('audioModesPanel');
  const headerMenu = document.getElementById('headerAudioModesMenu');
  const button = document.querySelector('.modes-nav');
  
  if (headerMenu) {
    headerMenu.hidden = !headerMenu.hidden;
  }
  if (panel) {
    panel.hidden = !panel.hidden;
    button?.setAttribute('aria-expanded', String(!panel.hidden));
  }
  updateAudioModeUI();
}

function updateAudioModeUI() {
  document.querySelectorAll('.audio-mode-option').forEach((option) => {
    option.classList.toggle('active', option.dataset.audioMode === state.audioMode);
  });
  document.querySelectorAll('.settings-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.audioMode);
  });
  const modeSelect = document.getElementById('settingsAudioModeSelect');
  if (modeSelect) modeSelect.value = state.audioMode;
}

function setAudioMode(mode) {
  const allowedModes = ['normal', 'boost', 'bass', 'nightcore'];
  if (!allowedModes.includes(mode)) return;
  initAudioEngine();
  state.audioMode = mode;
  localStorage.setItem('spoflix_audio_mode', mode);

  applyAudioModeSettings();
  applyVolumeSettings();
  updateAudioModeUI();

  const modeNames = {
    normal: 'Standart',
    boost: 'Ses Artırma (Boost 🔥 +%150)',
    bass: 'Bas Artırma (Bass Boost ⚡ Güçlü Bas)',
    nightcore: 'Nightcore 🌙'
  };
  showToast('Ses Modu: ' + (modeNames[mode] || mode));
}

function startAudioMotion() {
  initAudioEngine();
  audioContext?.resume?.().catch(() => {});
  cancelAnimationFrame(audioMotionFrame);
  const data = audioAnalyser ? new Uint8Array(audioAnalyser.frequencyBinCount) : null;
  const animate = () => {
    let level = 0.18;
    if (audioAnalyser && data) {
      audioAnalyser.getByteFrequencyData(data);
      level = data.reduce((sum, value) => sum + value, 0) / data.length / 255;
    } else if (state.isPlaying) {
      level = 0.28 + Math.abs(Math.sin(Date.now() / 180)) * 0.2;
    }
    document.documentElement.style.setProperty('--audio-level', level.toFixed(3));
    audioMotionFrame = requestAnimationFrame(animate);
  };
  animate();
}

const TEST_MP3_PLAYLIST = [
  { id: 'test_soundhelix_1', name: 'SoundHelix Song 1', artist: 'SoundHelix', album: 'Test Playlist', artwork: 'https://images.unsplash.com/photo-1493225457124-cac612d2d12f?auto=format&fit=crop&w=600&q=80', artworkSmall: 'https://images.unsplash.com/photo-1493225457124-cac612d2d12f?auto=format&fit=crop&w=300&q=80', previewUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', duration: 372, isFullSong: true },
  { id: 'test_soundhelix_2', name: 'SoundHelix Song 2', artist: 'SoundHelix', album: 'Test Playlist', artwork: 'https://images.unsplash.com/photo-1501612780327-45045538702b?auto=format&fit=crop&w=600&q=80', artworkSmall: 'https://images.unsplash.com/photo-1501612780327-45045538702b?auto=format&fit=crop&w=300&q=80', previewUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', duration: 374, isFullSong: true },
  { id: 'test_soundhelix_3', name: 'SoundHelix Song 3', artist: 'SoundHelix', album: 'Test Playlist', artwork: 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=600&q=80', artworkSmall: 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=300&q=80', previewUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', duration: 365, isFullSong: true },
  { id: 'test_soundhelix_4', name: 'SoundHelix Song 4', artist: 'SoundHelix', album: 'Test Playlist', artwork: 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=600&q=80', artworkSmall: 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=300&q=80', previewUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', duration: 362, isFullSong: true },
];
window.TEST_MP3_PLAYLIST = TEST_MP3_PLAYLIST;
function getFallbackTracks() {
  return TEST_MP3_PLAYLIST.map((track) => ({
    ...track,
    artwork: track.artwork || getDefaultArtwork(),
    artworkSmall: track.artworkSmall || track.artwork || getDefaultArtwork(),
  }));
}

// ── Audius API ──
const APP_NAME = 'SpoFliix';
const AUDIUS_HOSTS = ['https://discoveryprovider.audius.co','https://audius-discovery-1.altego.net','https://audius-discovery-2.altego.net','https://audius-discovery-3.altego.net','https://cn1.shakespearetech.com','https://v.monophonic.digital'];
async function getAudiusHost() {
  if (state.audiusHost) return state.audiusHost;
  for (const host of AUDIUS_HOSTS) {
    try {
      const r = await fetch(`${host}/v1/tracks/trending?app_name=${APP_NAME}&limit=1`);
      if (r.ok) { const d = await r.json(); if (d.data&&d.data.length>0) { state.audiusHost=host; return host; } }
    } catch(e) { console.warn(`Host ${host} failed`); }
  }
  state.audiusHost='https://discoveryprovider.audius.co'; return state.audiusHost;
}
async function audiusFetch(e,p={}) {
  const host = await getAudiusHost();
  const url = new URL(`${host}/v1${e}`);
  url.searchParams.append('app_name',APP_NAME);
  for (const[k,v] of Object.entries(p)) url.searchParams.append(k,v);
  try { const r=await fetch(url); if(!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()).data; } catch(e) { console.error('Audius error:',e); return []; }
}
function getDefaultArtwork(name, artist) {
  const palettes = [
    ['#1DB954','#16a085'],['#e91e8c','#9b59b6'],['#f39c12','#e74c3c'],
    ['#3498db','#2980b9'],['#8e44ad','#2c3e50'],['#e67e22','#c0392b'],
    ['#27ae60','#2ecc71'],['#2980b9','#8e44ad'],['#c0392b','#e74c3c'],
    ['#16a085','#1DB954']
  ];
  const text = name || artist || '';
  const letter = (text || '♫').trim()[0].toUpperCase();
  const idx = text ? Math.abs([...text].reduce((a,c)=>a+c.charCodeAt(0),0)) % palettes.length : 0;
  const [c1, c2] = palettes[idx];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect fill="url(#g)" width="100" height="100"/>
    <text y="64" x="50" text-anchor="middle" font-size="42" font-family="Arial,sans-serif" font-weight="bold" fill="rgba(255,255,255,0.9)">${letter}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
function mapAudiusTrack(track) {
  const art = track.artwork || {};
  // host null/undefined ise fallback yap; async getAudiusHost() cachelenmedi ise bozuk URL olur
  const host = state.audiusHost || 'https://discoveryprovider.audius.co';
  let url = '';
  if (track.stream && track.stream.url) {
    url = track.stream.url;
  } else {
    url = `${host}/v1/tracks/${track.id}/stream?app_name=${APP_NAME}`;
  }
  return { id:'audius_'+track.id, name:track.title||'Bilinmeyen Şarkı', artist:track.user?.name||'Bilinmeyen Sanatçı', album:track.album||track.genre||'Single', artwork:art['480x480']||art['150x150']||getDefaultArtwork(track.title, track.user?.name), artworkSmall:art['150x150']||art['480x480']||getDefaultArtwork(track.title, track.user?.name), previewUrl:url, duration:track.duration||0, genre:track.genre||'', isFullSong:true };
}
async function searchJamendo(q,l=25) {
  try {
    const url = new URL('https://api.jamendo.com/v3.0/tracks/');
    url.searchParams.set('client_id', 'a58ddd6d');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', l);
    url.searchParams.set('search', q);
    url.searchParams.set('audioformat', 'mp32');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).results.filter(t => t.audio).map(t => ({
      id: 'jamendo_' + t.id,
      name: t.name || 'Bilinmeyen Şarkı',
      artist: t.artist_name || 'Bilinmeyen Sanatçı',
      album: t.album_name || 'Single',
      artwork: t.album_image || getDefaultArtwork(t.name, t.artist_name),
      artworkSmall: t.album_image || getDefaultArtwork(t.name, t.artist_name),
      previewUrl: t.audio,
      duration: t.duration || 0,
      genre: t.musicinfo?.tags?.genres?.join(', ') || '',
      isFullSong: true
    }));
  } catch (e) { console.error('Jamendo error:', e); return []; }
}
async function searchYouTube(q,l=10) {
  try {
    const url = new URL('/api/youtube', window.location.origin);
    url.searchParams.set('q', String(q || '').slice(0, 150));
    url.searchParams.set('limit', String(Math.max(1, Math.min(25, Number(l) || 10))));
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).items || [];
  } catch (e) { console.error('YouTube search error:', e); return []; }
}
async function getYouTubeTrendingTracks(limit = 25) {
  try {
    const url = new URL('/api/youtube-trending', window.location.origin);
    url.searchParams.set('limit', String(Math.max(1, Math.min(25, Number(limit) || 25))));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).items || [];
  } catch (error) {
    console.error('YouTube Türkiye trend listesi yüklenemedi:', error);
    return [];
  }
}
// Kapak görseli eksik şarkıları YouTube'dan eşleştir
async function enrichTracksWithArtwork(tracks, maxBatch = 8) {
  const missing = tracks.filter(t =>
    !t.artwork || t.artwork === getDefaultArtwork() || t.artwork.startsWith('data:image/svg')
  );
  if (!missing.length) return tracks;
  // Batch: en fazla maxBatch şarkı için YouTube'dan thumbnail çek
  const batch = missing.slice(0, maxBatch);
  const results = await Promise.allSettled(
    batch.map(async (track) => {
      try {
        const q = `${track.artist} ${track.name}`;
        const ytResults = await searchYouTube(q, 1);
        if (ytResults && ytResults.length > 0 && ytResults[0].artwork) {
          return { id: track.id, artwork: ytResults[0].artwork, artworkSmall: ytResults[0].artworkSmall || ytResults[0].artwork };
        }
      } catch (e) { /* ignore */ }
      return null;
    })
  );
  const artMap = {};
  results.forEach(r => { if (r.status === 'fulfilled' && r.value) artMap[r.value.id] = r.value; });
  return tracks.map(t => {
    if (artMap[t.id]) return { ...t, artwork: artMap[t.id].artwork, artworkSmall: artMap[t.id].artworkSmall };
    if (!t.artwork || t.artwork.startsWith('data:image/svg')) return { ...t, artwork: getDefaultArtwork(t.name, t.artist), artworkSmall: getDefaultArtwork(t.name, t.artist) };
    return t;
  });
}

function searchDeezer(q,l=25) {
  return new Promise((resolve)=>{
    const cb='deezer_cb_'+Date.now()+'_'+Math.floor(Math.random()*100000),s=document.createElement('script');
    window[cb]=(d)=>{ delete window[cb]; if(s.parentNode) s.parentNode.removeChild(s); if(d&&d.data) resolve(d.data.slice(0,l).map(t=>({ id:'deezer_'+t.id, name:t.title||'Bilinmeyen Şarkı', artist:t.artist?.name||'Bilinmeyen Sanatçı', album:t.album?.title||'Single', artwork:t.album?.cover_xl||t.album?.cover_medium||getDefaultArtwork(t.title, t.artist?.name), artworkSmall:t.album?.cover_small||t.album?.cover_medium||getDefaultArtwork(t.title, t.artist?.name), previewUrl:t.preview||'', duration:t.duration||0, genre:'', isFullSong:false }))); else resolve([]); };
    s.onerror=()=>{ delete window[cb]; if(s.parentNode) s.parentNode.removeChild(s); resolve([]); };
    s.src=`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${l}&output=jsonp&callback=${cb}`;
    document.body.appendChild(s);
    setTimeout(()=>{ if(window[cb]) { delete window[cb]; if(s.parentNode) s.parentNode.removeChild(s); resolve([]); } },10000);
  });
}
const GENRE_MAP = { 'rock':'Rock','hip hop':'Hip-Hop/Rap','jazz':'Jazz/Blues','electronic':'Electronic','r&b':'R&B/Soul','latin':'Latin','k-pop':'K-Pop','indie':'Alternative','classical':'Classical','metal':'Metal','edm':'Dance/House','lofi':'Lo-Fi','reggae':'Reggae','country':'Country','techno':'Techno','ambient':'Ambient','world':'World','blues':'Blues','folk':'Folk','punk':'Punk','reggaeton':'Reggaeton' };
const SEARCH_GENRES = ['pop','türkçe pop','arabic pop','chill vibes','workout','top hits 2024','new music 2024','90s hits','türkçe', 'herems 2.0'];
async function getTrendingTracks(t='week',l=20) {
  try {
    const data = await audiusFetch('/tracks/trending', { time: t, limit: l });
    if (Array.isArray(data) && data.length > 0) return data.map(mapAudiusTrack);
  } catch (e) {
    console.warn('Trending fallback hit:', e);
  }
  return getFallbackTracks().slice(0, l);
}
async function searchAudius(q,l=50) {
  try {
    const data = await audiusFetch('/tracks/search', { query: q, limit: l });
    if (Array.isArray(data) && data.length > 0) return data.map(mapAudiusTrack);
  } catch (e) {
    console.warn('Audius search fallback hit:', e);
  }
  const term = (q || '').toLowerCase();
  if (!term) return getFallbackTracks().slice(0, l);
  return getFallbackTracks().filter((track) =>
    track.name.toLowerCase().includes(term) || track.artist.toLowerCase().includes(term) || track.album.toLowerCase().includes(term)
  ).slice(0, l);
}
async function getTracksByGenre(g,l=50) {
  if(SEARCH_GENRES.includes(g)) return searchAudius(g,l);
  const ag=GENRE_MAP[g]||g; let t=[];
  try { t = await audiusFetch('/tracks/trending',{genre:ag,limit:l}); } catch (e) { console.warn('Genre fetch failed:', e); }
  if(!Array.isArray(t) || t.length===0) {
    try { t = await audiusFetch('/tracks/search',{query:g,limit:l}); } catch (e) { console.warn('Genre search failed:', e); }
  }
  if(Array.isArray(t) && t.length>0) return t.map(mapAudiusTrack);
  return getFallbackTracks().slice(0, l);
}

// ── Navigation ──
function getTvFocusableElements() {
  const modal = document.querySelector('#settingsModal:not([hidden]), #loginModal:not([hidden])');
  const root = modal || document;
  return Array.from(root.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [data-tv-focusable="true"]'
  )).filter((element) => {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  });
}

function makeTvElementsFocusable(root) {
  if (!isTvBrowser || !root?.querySelectorAll) return;
  root.querySelectorAll('.track-card, .track-list-item, .genre-card, .yt-trend-card').forEach((element) => {
    if (element.hasAttribute('data-tv-focusable')) return;
    element.setAttribute('data-tv-focusable', 'true');
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
  });
}

function moveTvFocus(direction) {
  const elements = getTvFocusableElements();
  if (!elements.length) return;

  const current = elements.includes(document.activeElement) ? document.activeElement : null;
  if (!current) {
    focusFirstTvElement(state.currentView);
    return;
  }

  const currentRect = current.getBoundingClientRect();
  const currentX = currentRect.left + currentRect.width / 2;
  const currentY = currentRect.top + currentRect.height / 2;
  let best = null;
  let bestScore = Infinity;

  elements.forEach((candidate) => {
    if (candidate === current) return;
    const rect = candidate.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const primary = direction === 'left' ? currentX - x
      : direction === 'right' ? x - currentX
      : direction === 'up' ? currentY - y
      : y - currentY;
    if (primary <= 1) return;
    const secondary = direction === 'left' || direction === 'right'
      ? Math.abs(y - currentY)
      : Math.abs(x - currentX);
    const score = primary + secondary * 1.35;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });

  if (best) {
    best.focus();
    best.scrollIntoView(false);
  }
}

function focusFirstTvElement(view) {
  if (!isTvBrowser) return;
  const viewElement = document.getElementById(`view-${view || state.currentView}`);
  const candidates = getTvFocusableElements();
  const target = (view === 'home' || !view)
    ? document.querySelector('.nav-item[data-view="home"]')
    : viewElement?.querySelector('input:not([disabled]), button:not([disabled]), [data-tv-focusable="true"]');
  const visibleTarget = target && candidates.includes(target) ? target : null;
  (visibleTarget || document.querySelector('.nav-item.active') || candidates[0])?.focus();
}

function initializeTvControls() {
  if (!isTvBrowser) return;
  document.body.classList.add('tv-mode');
  makeTvElementsFocusable(document);
  if (window.MutationObserver) {
    const observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node.nodeType === 1) makeTvElementsFocusable(node);
      }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

function handleTvRemoteKey(event) {
  if (!isTvBrowser) return false;
  const code = event.keyCode || event.which;
  const key = event.key || '';
  const target = event.target;
  const isTextEntry = target && (
    target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  );

  if (key === 'Back' || key === 'GoBack' || key === 'BrowserBack' || key === 'Escape' || code === 10009) {
    const settings = document.getElementById('settingsModal');
    const login = document.getElementById('loginModal');
    const profile = document.getElementById('profileMenu');
    if (settings && !settings.hidden) closeSettings();
    else if (login && !login.hidden) closeLogin();
    else if (profile && !profile.hidden) toggleProfileMenu();
    else if (state.currentView !== 'home') navigateTo('home');
    else return false;
    event.preventDefault();
    setTimeout(() => focusFirstTvElement(state.currentView), 0);
    return true;
  }

  if (isTextEntry) return false;

  const directions = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  };
  const direction = directions[key] || ({ 37: 'left', 39: 'right', 38: 'up', 40: 'down' })[code];
  if (direction) {
    if (target?.tagName === 'INPUT' && target.type === 'range') return false;
    event.preventDefault();
    moveTvFocus(direction);
    return true;
  }

  if (key === 'MediaPlayPause' || code === 10252) {
    event.preventDefault();
    togglePlayPause();
    return true;
  }
  if (key === 'MediaPlay' || code === 415) {
    event.preventDefault();
    if (!state.isPlaying) togglePlayPause();
    return true;
  }
  if (key === 'MediaPause' || code === 19) {
    event.preventDefault();
    if (state.isPlaying) togglePlayPause();
    return true;
  }
  if (key === 'MediaTrackNext' || code === 10233) {
    event.preventDefault();
    playNext();
    return true;
  }
  if (key === 'MediaTrackPrevious' || code === 10232) {
    event.preventDefault();
    playPrev();
    return true;
  }
  if (key === 'VolumeUp' || code === 447) {
    event.preventDefault();
    state.volume = Math.min(1, state.volume + 0.05);
    state.isMuted = false;
    applyVolumeSettings();
    return true;
  }
  if (key === 'VolumeDown' || code === 448) {
    event.preventDefault();
    state.volume = Math.max(0, state.volume - 0.05);
    state.isMuted = false;
    applyVolumeSettings();
    return true;
  }
  if (key === 'VolumeMute' || code === 449) {
    event.preventDefault();
    toggleMute();
    return true;
  }

  if (key === 'Enter' || key === 'OK' || code === 13) {
    if (target?.hasAttribute('data-tv-focusable')) {
      event.preventDefault();
      if (!event.repeat) target.click();
      return true;
    }
    return false;
  }

  if (key === ' ' || key === 'Spacebar' || code === 32) {
    if (target?.matches('button, a[href]')) return true;
    if (target?.hasAttribute('data-tv-focusable')) {
      event.preventDefault();
      if (!event.repeat) target.click();
    } else {
      event.preventDefault();
      togglePlayPause();
    }
    return true;
  }

  return false;
}

function navigateTo(v) {
  state.currentView=v;
  document.querySelectorAll('.view').forEach(el=>{el.style.display='none';el.classList.remove('active');});
  const tv=document.getElementById('view-'+v); if(tv) { tv.style.display='block'; tv.classList.add('active'); }
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===v));
  document.getElementById('headerSearch').classList.toggle('active',v==='search');
  updateBgGradient(v); document.getElementById('mainContent').scrollTop=0;
  if(v==='search'){ 
    setTimeout(()=>{
      const si=document.getElementById('searchInput');
      const spi=document.getElementById('searchPageInput');
      if(si && document.activeElement !== si && document.activeElement !== spi) spi.focus();
    },100); 
    populateSearchGenres(); 
  }
  else if(v==='liked') renderLikedSongs();
  else if(v==='library'){ renderRecentlyPlayed(); updateLikedCountDisplay(); }
  else if(v==='upload') renderMySongs();
  if (isTvBrowser) setTimeout(() => focusFirstTvElement(v), 0);
}
function updateBgGradient(v) {
  const g=document.getElementById('mainBgGradient'),grads={home:'linear-gradient(180deg,rgba(29,185,84,0.15)0%,transparent 100%)',search:'linear-gradient(180deg,rgba(124,58,237,0.15)0%,transparent 100%)',library:'linear-gradient(180deg,rgba(59,130,246,0.15)0%,transparent 100%)',liked:'linear-gradient(180deg,rgba(124,58,237,0.2)0%,transparent 100%)',playlist:'linear-gradient(180deg,rgba(29,185,84,0.2)0%,transparent 100%)',upload:'linear-gradient(180deg,rgba(233,30,140,0.15)0%,transparent 100%)'};
  g.style.background=grads[v]||grads.home;
}

// ── Search ──
function handleSearch(q) {
  const query = String(q || '').trim();
  clearTimeout(state.searchTimeout);
  const si = document.getElementById('searchInput');
  const spi = document.getElementById('searchPageInput');
  if (si && si.value !== q) si.value = q;
  if (spi && spi.value !== q) spi.value = q;
  if (state.currentView !== 'search') navigateTo('search');

  const results = document.getElementById('searchResults');
  if (!results) return;
  state.searchQuery = query;
  state.currentPlaylistTracks = [];

  if (query.length < 2) {
    results.innerHTML = '<div class="section-header"><h2 class="section-title">Popüler Aramalar</h2></div><div class="genre-grid" id="searchGenreGrid"></div>';
    populateSearchGenres();
    return;
  }

  state.searchTimeout = setTimeout(async () => {
    if (state.searchQuery !== query) return;
    results.innerHTML = '<div class="loading-spinner" role="status" aria-label="Şarkılar aranıyor"><div class="spinner"></div></div>';

    const responses = await Promise.allSettled([
      searchYouTube(query, 15),
      searchJamendo(query, 20),
      searchDeezer(query, 20),
      searchAudius(query, 20)
    ]);
    if (state.searchQuery !== query) return;

    const valueOrEmpty = (result) => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : [];
    const [youtubeTracks, jamendoTracks, deezerTracks, audiusTracks] = responses.map(valueOrEmpty);
    const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const normalizedQuery = normalize(query);
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    const candidates = [...youtubeTracks, ...audiusTracks, ...jamendoTracks, ...deezerTracks];
    const seen = new Set();
    const tracks = candidates.filter((track) => {
      if (!track || (!track.isFullSong && !String(track.id || '').startsWith('local_'))) return false;
      const searchable = normalize(`${track.name || ''} ${track.artist || ''}`);
      if (terms.some((term) => !searchable.includes(term))) return false;
      const key = `${normalize(track.artist)}|${normalize(track.name)}`;
      if (!track.name || !track.artist || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 60);

    state.currentPlaylistTracks = tracks;
    state.currentGenre = query;
    renderSearchResults();

    enrichTracksWithArtwork(tracks, 10).then((enriched) => {
      if (state.searchQuery !== query || !enriched.length) return;
      state.currentPlaylistTracks = enriched;
      renderSearchResults();
    }).catch((error) => console.warn('Search artwork lookup failed:', error));
  }, 350);
}

function renderSearchResults() {
  const results = document.getElementById('searchResults');
  if (!results) return;
  const tracks = state.currentPlaylistTracks || [];

  if (!tracks.length) {
    results.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎧</div>
        <h3 class="empty-state-title">Şarkı bulunamadı</h3>
        <p class="empty-state-text">"${escapeHtml(state.searchQuery || '')}" için sonuç bulunamadı. Başka bir şarkı veya sanatçı deneyin.</p>
      </div>`;
    return;
  }

  results.innerHTML = `
    <div class="section-header" style="margin-top: 16px;">
      <h2 class="section-title">Şarkı Sonuçları</h2>
      <span class="section-see-all">${tracks.length} şarkı</span>
    </div>
    <div class="track-list">
      <div class="track-list-header"><span>#</span><span>Başlık</span><span>Albüm</span><span>İşlemler & Süre</span></div>
      ${tracks.map((track, index) => renderTrackListItem(track, index, 'search')).join('')}
    </div>`;
}
function populateSearchGenres() {
  const grid=document.getElementById('searchGenreGrid'); if(!grid) return;
  grid.innerHTML=[{n:'Pop',c:'genre-pop',e:'🎤',q:'pop'},{n:'Rock',c:'genre-rock',e:'🎸',q:'rock'},{n:'Hip-Hop',c:'genre-hiphop',e:'🎧',q:'hip hop'},{n:'Türkçe',c:'genre-turkish',e:'🇹🇷',q:'türkçe pop'},{n:'Electronic',c:'genre-electronic',e:'🎹',q:'electronic'},{n:'R&B',c:'genre-rnb',e:'🎙️',q:'r&b'},{n:'Jazz',c:'genre-jazz',e:'🎷',q:'jazz'},{n:'K-Pop',c:'genre-kpop',e:'🌸',q:'k-pop'},{n:'Latin',c:'genre-latin',e:'💃',q:'latin'},{n:'Lo-Fi',c:'genre-lofi',e:'🌙',q:'lofi'},{n:'Klasik',c:'genre-classical',e:'🎻',q:'classical'},{n:'Indie',c:'genre-indie',e:'🌟',q:'indie'},{n:'Metal',c:'genre-metal',e:'🤘',q:'metal'},{n:'Reggae',c:'genre-reggae',e:'🌴',q:'reggae'},{n:'Techno',c:'genre-techno',e:'⚡',q:'techno'},{n:'Ambient',c:'genre-ambient',e:'🌌',q:'ambient'}].map(g=>'<div class="genre-card" onclick="loadGenrePlaylist(\''+g.q+'\')"><div class="genre-card-bg '+g.c+'"></div><div class="genre-card-content"><span class="genre-card-title">'+g.n+'</span></div><span class="genre-card-emoji">'+g.e+'</span></div>').join('');
}

// ── Genre/Playlist Loading ──
async function loadGenrePlaylist(genre) {
  navigateTo('playlist'); state.currentGenre=genre; state.loadedTrackIds=new Set();
  const emojis={pop:'🎤',rock:'🎸','hip hop':'🎧',jazz:'🎷',electronic:'🎹','r&b':'🎙️','türkçe pop':'🇹🇷',latin:'💃','k-pop':'🌸',indie:'🌙',classical:'🎻',metal:'🤘','pop hits':'🔥',workout:'💪',edm:'🎉',lofi:'🌙',reggae:'🌴',techno:'⚡',ambient:'🌌','arabic pop':'🎵','herems 2.0':'🔥'};
  const names={pop:'Pop',rock:'Rock Klasikleri','hip hop':'Hip-Hop Vibes',jazz:'Jazz Koleksiyonu',electronic:'Electronic Party','r&b':'R&B Mood','türkçe pop':'Türkçe Pop',latin:'Latin Ateşi','k-pop':'K-Pop Dünyası',indie:'Indie Keşifler',classical:'Klasik Müzik',metal:'Metal Zone','pop hits':'Pop Hits 🔥',workout:'Workout Mix 💪',edm:'EDM Party 🎉',lofi:'Lo-Fi Beats 🌙',reggae:'Reggae Vibes 🌴',techno:'Techno Underground ⚡',ambient:'Ambient Dreams 🌌','arabic pop':'Arabesk 🎵','herems 2.0':'Herems 2.0'};
  const colors={pop:['#e91e8c','#ff6b9d'],rock:['#e74c3c','#c0392b'],'hip hop':['#f39c12','#e67e22'],jazz:['#2ecc71','#27ae60'],electronic:['#3498db','#2980b9'],'r&b':['#9b59b6','#8e44ad'],'türkçe pop':['#e74c3c','#c0392b'],latin:['#f97316','#ea580c'],'k-pop':['#ec4899','#a855f7'],indie:['#6366f1','#4f46e5'],classical:['#1abc9c','#16a085'],metal:['#374151','#111827'],edm:['#06b6d4','#0891b2'],lofi:['#8b5cf6','#6d28d9'],reggae:['#22c55e','#16a34a'],techno:['#3b82f6','#1d4ed8'],ambient:['#6366f1','#4338ca'],'arabic pop':['#14b8a6','#0d9488'],'herems 2.0':['#e91e8c','#7c3aed']};
  const emoji=emojis[genre]||'🎵',name=names[genre]||genre.charAt(0).toUpperCase()+genre.slice(1),c=colors[genre]||['#1db954','#191414'];
  document.getElementById('playlistEmoji').textContent=emoji; document.getElementById('playlistTitle').textContent=name;
  document.getElementById('playlistArt').style.background=`linear-gradient(135deg,${c[0]},${c[1]})`;
  const tld=document.getElementById('playlistTrackList'); tld.innerHTML='<div class="loading-spinner"><div class="spinner"></div></div>';
  const lmb=document.getElementById('loadMoreBtn'); if(lmb) lmb.style.display='none';
  const tracks=await getTracksByGenre(genre,50); state.currentPlaylistTracks=tracks;
  tracks.forEach(t=>state.loadedTrackIds.add(t.id)); document.getElementById('playlistCount').textContent=`${tracks.length} şarkı`;
  if(tracks.length===0){ tld.innerHTML='<div class="empty-state"><div class="empty-state-icon">😔</div><h3 class="empty-state-title">Şarkı bulunamadı</h3><p class="empty-state-text">Bu tür için şarkı bulunamadı. Farklı bir tür dene.</p></div>'; return; }
  tld.innerHTML='<div class="track-list"><div class="track-list-header"><span>#</span><span>Başlık</span><span>Albüm</span><span>Süre</span></div>'+tracks.map((t,i)=>renderTrackListItem(t,i, 'playlist')).join('')+'</div>';
  if(lmb) { lmb.style.display='inline-flex'; lmb.textContent='Daha Fazla Yükle'; lmb.disabled=false; }
}
async function loadMoreTracks() {
  if(state.isLoadingMore||!state.currentGenre) return; state.isLoadingMore=true;
  const lmb=document.getElementById('loadMoreBtn'); if(lmb){ lmb.textContent='Yükleniyor...'; lmb.disabled=true; }
  const qs=[state.currentGenre,state.currentGenre+' hits',state.currentGenre+' 2024','popular '+state.currentGenre,'best '+state.currentGenre];
  const idx=Math.floor(state.currentPlaylistTracks.length/50)%qs.length;
  const more=await searchAudius(qs[idx],50); const nt=more.filter(t=>!state.loadedTrackIds.has(t.id));
  nt.forEach(t=>state.loadedTrackIds.add(t.id));
  if(nt.length===0){ if(lmb){ lmb.textContent='Daha fazla şarkı yok'; lmb.disabled=true; } state.isLoadingMore=false; return; }
  const start=state.currentPlaylistTracks.length; state.currentPlaylistTracks=[...state.currentPlaylistTracks,...nt];
  document.getElementById('playlistCount').textContent=`${state.currentPlaylistTracks.length} şarkı`;
  const tl=document.querySelector('#playlistTrackList .track-list'); if(tl) tl.insertAdjacentHTML('beforeend',nt.map((t,i)=>renderTrackListItem(t,start+i, 'playlist')).join(''));
  if(lmb){ lmb.textContent='Daha Fazla Yükle'; lmb.disabled=false; } state.isLoadingMore=false;
}
function playAllPlaylist() { if(state.currentPlaylistTracks.length>0){ state.queue=[...state.currentPlaylistTracks]; state.queueIndex=0; playTrack(state.queue[0]); } }

// ── Track Rendering ──
function renderTrackCard(track,index,gridId) {
  const ip=state.currentTrack&&state.currentTrack.id===track.id&&state.isPlaying;
  const il=state.likedSongs.some(s=>s.id===track.id);
  const likeFill = il ? 'currentColor' : 'none';
  const trackIdStr = String(track.id).replace(/'/g, "\\'");
  return `<div class="track-card ${ip?'playing':''}" onclick="playFromGrid('${gridId}',${index})" data-track-id="${track.id}"><div class="track-card-art"><img src="${track.artwork}" alt="${escapeHtml(track.name)}" loading="lazy" onerror="this.src=getDefaultArtwork()"><button class="track-card-play" onclick="event.stopPropagation();playFromGrid('${gridId}',${index})">${ip?'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>':'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'}</button><button class="card-like-btn ${il?'liked':''}" onclick="event.stopPropagation();toggleLikeById('${trackIdStr}')"><svg viewBox="0 0 24 24" fill="${likeFill}" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></button></div><div class="track-card-info"><div class="track-card-name">${escapeHtml(track.name)}</div><div class="track-card-artist">${escapeHtml(track.artist)}</div></div></div>`;
}
function renderYouTubeTrendingList(tracks) {
  return `<div class="yt-trend-cards">
    ${tracks.map((track, index) => {
      const isPlaying = state.currentTrack?.id === track.id && state.isPlaying;
      const isLiked = state.likedSongs.some((song) => String(song.id) === String(track.id));
      const likeFill = isLiked ? 'currentColor' : 'none';
      const safeId = String(track.id).replace(/[^\w-]/g, '');
      const artwork = escapeHtml(track.artwork || track.artworkSmall || getDefaultArtwork());
      return `<div class="yt-trend-card ${isPlaying ? 'playing' : ''}" onclick="playFromContext('youtubeTrending', ${index})" data-track-id="${safeId}">
        <div class="yt-trend-card-art">
          <img src="${artwork}" alt="${escapeHtml(track.name)}" loading="lazy" onerror="this.src=getDefaultArtwork()">
          <div class="yt-trend-card-rank">${index + 1}</div>
          <button class="yt-trend-card-play" onclick="event.stopPropagation();playFromContext('youtubeTrending', ${index})">
            ${isPlaying
              ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'}
          </button>
        </div>
        <div class="yt-trend-card-body">
          <div class="yt-trend-card-name" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</div>
          <div class="yt-trend-card-artist" title="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</div>
          <div class="yt-trend-card-meta">
            <span class="yt-badge-yt">YouTube</span>
            ${track.duration ? `<span class="yt-trend-dur">${formatTime(track.duration)}</span>` : ''}
          </div>
        </div>
        <button class="yt-trend-card-like ${isLiked ? 'liked' : ''}" onclick="event.stopPropagation();toggleLikeById('${safeId}')" title="Begen">
          <svg viewBox="0 0 24 24" fill="${likeFill}" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        </button>
      </div>`;
    }).join('')}
  </div>`;
}
function renderTrackListItem(track, index, context = 'playlist') {
  const isPlaying = state.currentTrack && state.currentTrack.id === track.id;
  const isLiked = state.likedSongs.some((song) => String(song.id) === String(track.id));
  const duration = Number(track.duration) > 0 ? formatTime(Number(track.duration)) : '—';
  const playIndicator = isPlaying && state.isPlaying
    ? '<div class="equalizer"><div class="equalizer-bar"></div><div class="equalizer-bar"></div><div class="equalizer-bar"></div><div class="equalizer-bar"></div></div>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const trackId = String(track.id || '').replace(/[^\w-]/g, '');
  const artwork = escapeHtml(track.artworkSmall || track.artwork || getDefaultArtwork());
  const likeFill = isLiked ? 'currentColor' : 'none';

  return `<div class="track-list-item ${isPlaying ? 'playing' : ''}" onclick="playFromContext('${context}', ${index})" data-track-id="${trackId}">
    <div><span class="track-list-number">${index + 1}</span><span class="track-list-play-icon">${playIndicator}</span></div>
    <div class="track-list-info">
      <div class="track-list-art"><img src="${artwork}" alt="" loading="lazy" onerror="this.src=getDefaultArtwork()"></div>
      <div class="track-list-text"><div class="track-list-name">${escapeHtml(track.name || 'Bilinmeyen Şarkı')}</div><div class="track-list-artist">${escapeHtml(track.artist || 'Bilinmeyen Sanatçı')}</div></div>
    </div>
    <div class="track-list-album">${escapeHtml(track.album || '')}</div>
    <div class="track-list-actions">
      <button class="track-like-btn ${isLiked ? 'liked' : ''}" onclick="event.stopPropagation();toggleLikeById('${trackId}')" title="Beğen" aria-label="${isLiked ? 'Beğenilenlerden çıkar' : 'Beğen'}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="${likeFill}" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
      </button>
      <span class="track-list-duration">${duration}</span>
    </div>
  </div>`;
}

function playFromContext(context, idx) {
  const queues = {
    search: state.currentPlaylistTracks,
    playlist: state.currentPlaylistTracks,
    youtubeTrending: state.youtubeTrendingTracks,
    liked: state.likedSongs,
    mySongs: state.mySongs
  };
  const tracks = queues[context];
  if (!Array.isArray(tracks) || !Number.isInteger(idx) || idx < 0 || idx >= tracks.length) return;
  state.queue = [...tracks];
  state.queueIndex = idx;
  playTrack(state.queue[idx]);
}

function toggleLikeById(id) {
  const allTracks = [...state.youtubeTrendingTracks, ...state.currentPlaylistTracks, ...state.likedSongs, ...state.mySongs, ...state.recentlyPlayed];
  if (state.currentTrack) allTracks.push(state.currentTrack);
  const track = allTracks.find(t => String(t.id) === String(id));
  if (track) toggleLikeTrack(track);
}
function renderSkeletonCards(c) { return Array(c).fill('').map(()=>'<div class="skeleton-card"><div class="skeleton skeleton-art"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text-sm"></div></div>').join(''); }

// ── Playback ──
function updatePlayerUI() {
  const player = document.querySelector('.player');
  const t=state.currentTrack;
  if (!t) { player?.classList.add('player-hidden'); player?.style.removeProperty('display'); return; }
  player?.classList.remove('player-hidden');
  player?.style.removeProperty('display');
  document.getElementById('playerTrackName').textContent=t.name;
  document.getElementById('playerTrackArtist').textContent=t.artist;
  updateLyricsSyncLabel();
  const ai=document.getElementById('playerArtImg'); ai.src=t.artworkSmall||t.artwork; ai.onerror=function(){this.src=getDefaultArtwork();};
  document.getElementById('playerArt').classList.toggle('playing',state.isPlaying);
  document.getElementById('iconPlay').style.display=state.isPlaying?'none':'block';
  document.getElementById('iconPause').style.display=state.isPlaying?'block':'none';
  const il=state.likedSongs.some(s=>s.id===t.id);
  const lb=document.getElementById('playerLikeBtn'); lb.classList.toggle('liked',il);
  lb.innerHTML=il?'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
  document.title=t.name+' - '+t.artist+' | Spoflix';
  if('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.name,
        artist: t.artist,
        album: t.album || 'SpoFlix',
        artwork: [
          { src: t.artworkSmall || t.artwork || getDefaultArtwork(), sizes: '150x150', type: 'image/jpeg' },
          { src: t.artwork || getDefaultArtwork(), sizes: '480x480', type: 'image/jpeg' },
          { src: t.artwork || getDefaultArtwork(), sizes: '512x512', type: 'image/jpeg' }
        ]
      });
      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', () => { if (!state.isPlaying) togglePlayPause(); });
      navigator.mediaSession.setActionHandler('pause', () => { if (state.isPlaying) togglePlayPause(); });
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) {
          if (state.playbackMode === 'youtube' && ytPlayer?.seekTo) ytPlayer.seekTo(details.seekTime, true);
          else audio.currentTime = details.seekTime;
        }
      });
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const skip = details.seekOffset || 10;
        if (state.playbackMode === 'youtube' && ytPlayer?.seekTo) ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime() - skip), true);
        else audio.currentTime = Math.max(0, audio.currentTime - skip);
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const skip = details.seekOffset || 10;
        if (state.playbackMode === 'youtube' && ytPlayer?.seekTo) ytPlayer.seekTo(ytPlayer.getCurrentTime() + skip, true);
        else audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + skip);
      });
    } catch (e) {
      console.warn('mediaSession error:', e);
    }
  }
}
async function toggleLyrics() {
  const panel = document.getElementById('lyricsPanel');
  if (!panel) return;
  const opening = !panel.classList.contains('open');
  panel.classList.toggle('open', opening);
  document.getElementById('lyricsBtn')?.classList.toggle('active', opening);
  panel.setAttribute('aria-hidden', String(!opening));
  if (!opening || !state.currentTrack) return;
  loadLyricsForTrack(state.currentTrack);
}
async function loadLyricsForTrack(track) {
  const panel = document.getElementById('lyricsPanel');
  const title = document.getElementById('lyricsTitle');
  const content = document.getElementById('lyricsContent');
  if (!panel || !title || !content || !track) return;
  const requestId = ++state.lyricRequestId;
  const lyricTrackId = track.id;
  title.textContent = track.name;
  content.innerHTML = '<div class="lyrics-loading">Müzik çalıyor, canlı sözler yükleniyor...</div>';
  state.lyricLines = [];
  state.lyricTrackId = lyricTrackId;
  state.activeLyricIndex = -1;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const trackName = track.name
      .replace(/\s*\|.*$/i, '')
      .replace(/\s*[-–]\s*(official|music video|audio).*$/i, '')
      .trim();
    const artistName = track.artist
      .replace(/\s*(official|vevo|records|channel).*$/i, '')
      .trim();
    const exactUrl = new URL('https://lrclib.net/api/get');
    exactUrl.searchParams.set('track_name', trackName);
    exactUrl.searchParams.set('artist_name', artistName);
    let response = await fetch(exactUrl, { signal: controller.signal });
    let data = response.ok ? await response.json() : null;

    if (!data) {
      const searchUrl = new URL('https://lrclib.net/api/search');
      searchUrl.searchParams.set('q', `${trackName} ${artistName}`);
      response = await fetch(searchUrl, { signal: controller.signal });
      const results = response.ok ? await response.json() : [];
      data = findMatchingLyrics(results, trackName, artistName);
    }

    if (requestId !== state.lyricRequestId || state.currentTrack?.id !== lyricTrackId) return;
    if (data?.syncedLyrics) {
      state.lyricLines = parseSyncedLyrics(data.syncedLyrics);
      renderLyrics();
      syncLyrics(getPlaybackTime());
      return;
    }

    const lyrics = data?.plainLyrics?.trim();
    content.innerHTML = lyrics
      ? `<div class="lyrics-plain">${escapeHtml(lyrics).replace(/\n/g, '<br>')}</div><div class="lyrics-note">Bu parça için zaman kodlu söz bulunamadı.</div>`
      : '<div class="lyrics-empty">Bu parça için söz bulunamadı.</div>';
  } catch (error) {
    if (requestId === state.lyricRequestId) content.innerHTML = '<div class="lyrics-empty">Canlı söz bulunamadı; müzik çalmaya devam ediyor.</div>';
  } finally {
    clearTimeout(timeoutId);
  }
}
function findMatchingLyrics(results, trackName, artistName) {
  if (!Array.isArray(results)) return null;
  const normalize = (value) => (value || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const title = normalize(trackName);
  const artist = normalize(artistName);
  const titleWords = title.split(' ').filter(word => word.length > 2);
  const artistWords = artist.split(' ').filter(word => word.length > 2);
  return results
    .filter(item => item.plainLyrics || item.syncedLyrics)
    .map(item => {
      const resultTitle = normalize(item.trackName || item.name);
      const resultArtist = normalize(item.artistName || item.artist);
      const titleMatches = titleWords.filter(word => resultTitle.includes(word)).length;
      const artistMatches = artistWords.filter(word => resultArtist.includes(word)).length;
      const exactTitle = resultTitle === title ? 5 : 0;
      return { item, score: exactTitle + titleMatches + artistMatches * 2 };
    })
    .filter(candidate => candidate.score >= 2)
    .sort((a, b) => b.score - a.score)[0]?.item || null;
}
function parseSyncedLyrics(rawLyrics) {
  return rawLyrics.split('\n').flatMap((line) => {
    const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = line.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    if (!text) return [];
    return matches.map((match) => ({
      time: Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || '0'}`),
      text,
    }));
  }).sort((a, b) => a.time - b.time);
}
function renderLyrics() {
  const content = document.getElementById('lyricsContent');
  if (!content) return;
  content.innerHTML = state.lyricLines.map((line, index) =>
    `<button class="lyric-line" data-lyric-index="${index}" onclick="seekToLyric(${line.time})">${escapeHtml(line.text)}</button>`
  ).join('');
}
function getPlaybackTime() {
  if (state.playbackMode === 'youtube' && ytPlayer?.getCurrentTime) return ytPlayer.getCurrentTime() || 0;
  return audio.currentTime || 0;
}
function getLyricsOffset(track = state.currentTrack) {
  if (!track) return 0;
  if (Object.prototype.hasOwnProperty.call(state.lyricOffsets, track.id)) return state.lyricOffsets[track.id];
  const name = `${track.artist || ''} ${track.name || ''}`.toLowerCase();
  if (name.includes('manifest') && name.includes('hileli')) {
    return name.includes('ajda pekkan') || name.includes('x ajda') ? 8 : -1;
  }
  return 0;
}
function syncLyrics(currentTime) {
  if (!state.lyricLines.length || state.lyricTrackId !== state.currentTrack?.id) return;
  if (state.playbackMode === 'audio' && audio.paused) return;
  const offset = getLyricsOffset(state.currentTrack);
  let nextIndex = -1;
  for (let index = 0; index < state.lyricLines.length; index += 1) {
    if (state.lyricLines[index].time <= currentTime - offset) nextIndex = index;
    else break;
  }
  if (nextIndex === state.activeLyricIndex) return;
  state.activeLyricIndex = nextIndex;
  document.querySelectorAll('.lyric-line').forEach((line, index) => {
    line.classList.toggle('active', index === nextIndex);
    if (index === nextIndex && nextIndex >= 0) line.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
function seekToLyric(time) {
  const offset = getLyricsOffset(state.currentTrack);
  const playbackTime = time + offset;
  if (state.playbackMode === 'youtube' && ytPlayer?.seekTo) ytPlayer.seekTo(playbackTime, true);
  else audio.currentTime = playbackTime;
  syncLyrics(playbackTime);
}
function adjustLyricsSync(amount) {
  if (!state.currentTrack) return;
  const trackId = state.currentTrack.id;
  state.lyricOffsets[trackId] = Math.max(-60, Math.min(60, getLyricsOffset(state.currentTrack) + amount));
  localStorage.setItem('spoflix_lyric_offsets', JSON.stringify(state.lyricOffsets));
  updateLyricsSyncLabel();
  syncLyrics(getPlaybackTime());
}
function updateLyricsSyncLabel() {
  const label = document.getElementById('lyricsSyncValue');
  if (!label) return;
  const offset = getLyricsOffset(state.currentTrack);
  label.textContent = `${offset >= 0 ? '+' : ''}${offset.toFixed(1)}s`;
}
function updatePlayingStates() {
  document.querySelectorAll('.track-card,.track-list-item').forEach(el=>{el.classList.toggle('playing',state.currentTrack&&String(state.currentTrack.id)===String(el.dataset.trackId));});
}
function playNext() {
  if(state.queue.length===0) return;
  if(state.repeatMode===2) { audio.currentTime=0; audio.play(); return; }
  if(state.isShuffle) state.queueIndex=Math.floor(Math.random()*state.queue.length);
  else { state.queueIndex++; if(state.queueIndex>=state.queue.length) { if(state.repeatMode===1) state.queueIndex=0; else { state.queueIndex=state.queue.length-1; audio.pause(); state.isPlaying=false; updatePlayerUI(); return; } } }
  playTrack(state.queue[state.queueIndex]);
}
function playPrev() {
  if(state.queue.length===0) return;
  if(audio.currentTime>3) { audio.currentTime=0; return; }
  state.queueIndex--; if(state.queueIndex<0) state.queueIndex=state.repeatMode===1?state.queue.length-1:0;
  playTrack(state.queue[state.queueIndex]);
}
function toggleShuffle() { state.isShuffle=!state.isShuffle; document.getElementById('btnShuffle').classList.toggle('active',state.isShuffle); showToast(state.isShuffle?'Karıştırma açık':'Karıştırma kapalı'); }
function toggleRepeat() {
  state.repeatMode=(state.repeatMode+1)%3;
  const btn=document.getElementById('btnRepeat'); btn.classList.toggle('active',state.repeatMode>0);
  showToast(['Tekrar kapalı','Tümünü tekrarla','Bir şarkıyı tekrarla'][state.repeatMode]);
  if(state.repeatMode===2) { btn.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg><span style="position:absolute;font-size:9px;font-weight:800;top:50%;left:50%;transform:translate(-50%,-50%);">1</span>'; btn.style.position='relative'; }
  else { btn.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>'; btn.style.position=''; }
}
function playFromGrid(gid,idx) { const gd=window['_gridData_'+gid]||[]; if(gd.length>0) { state.queue=[...gd]; state.queueIndex=idx; playTrack(state.queue[state.queueIndex]); } }
function playFromPlaylist(idx) { state.queue=[...state.currentPlaylistTracks]; state.queueIndex=idx; playTrack(state.queue[state.queueIndex]); }
function openYouTube(artist,name) { window.open('https://www.youtube.com/results?search_query='+encodeURIComponent(artist+' '+name),'_blank','noopener'); }

function getEventClientX(e) {
  if (e.touches && e.touches.length > 0) return e.touches[0].clientX;
  if (e.changedTouches && e.changedTouches.length > 0) return e.changedTouches[0].clientX;
  return e.clientX || 0;
}

// ── Volume ──
let isDraggingVolume = false;
function startVolumeDrag(e) {
  isDraggingVolume = true;
  updateVolumeFromEvent(e);
  window.addEventListener('mousemove', handleVolumeDrag);
  window.addEventListener('mouseup', stopVolumeDrag);
  window.addEventListener('touchmove', handleVolumeDrag, { passive: false });
  window.addEventListener('touchend', stopVolumeDrag);
}
function handleVolumeDrag(e) {
  if (isDraggingVolume) {
    if (e.cancelable) e.preventDefault();
    updateVolumeFromEvent(e);
  }
}
function stopVolumeDrag() {
  isDraggingVolume = false;
  window.removeEventListener('mousemove', handleVolumeDrag);
  window.removeEventListener('mouseup', stopVolumeDrag);
  window.removeEventListener('touchmove', handleVolumeDrag);
  window.removeEventListener('touchend', stopVolumeDrag);
}
function updateVolumeIcon() {
  document.getElementById('iconVolumeHigh').style.display = state.isMuted ? 'none' : 'block';
  document.getElementById('iconVolumeMuted').style.display = state.isMuted ? 'block' : 'none';
}

// ── Progress Bar ──
function startSeek(e) {
  state.isSeeking = true;
  const duration = audio.duration || 0;
  const onMove = (evt) => {
    if (!state.isSeeking) return;
    if (evt.cancelable) evt.preventDefault();
    const bar = document.getElementById('progressBar');
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const cx = getEventClientX(evt);
    const ratio = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
    document.getElementById('progressFill').style.width = `${ratio * 100}%`;
    document.getElementById('currentTime').textContent = formatTime(ratio * duration);
  };
  const onUp = (evt) => {
    state.isSeeking = false;
    seekTo(evt);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);
}

audio.addEventListener('canplay', () => { state.audioReady = true; });

// Mobilde arka planda kesintisiz geçiş: setTimeout olmadan anında sonraki şarkıya geç
audio.addEventListener('ended', () => {
  if (state.playbackMode !== 'audio' || !state.currentTrack?.previewUrl) return;
  if (state.repeatMode === 2) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  state.errorCount = 0;
  playNext();
});

audio.addEventListener('error', (e) => {
  if (state.playbackMode !== 'audio' || !state.currentTrack?.previewUrl) return;
  const failedToken = state.playToken;
  const failedTrackId = state.currentTrack.id;
  console.warn('Audio error:', e);
  state.errorCount++;
  if (state.errorCount < state.maxErrors) {
    showToast('Şarkı yüklenemedi, sonraki deneniyor...');
    setTimeout(() => {
      if (failedToken !== state.playToken || state.currentTrack?.id !== failedTrackId || state.playbackMode !== 'audio') return;
      playNext();
    }, 1000);
  } else {
    showToast('Çok fazla hata oluştu.');
    state.isPlaying = false;
    updatePlayerUI();
    state.errorCount = 0;
  }
});

// ── Likes ──
function toggleLikeCurrent() { if(state.currentTrack) toggleLikeTrack(state.currentTrack); }
function toggleLikeTrack(track) {
  const idx=state.likedSongs.findIndex(s=>s.id===track.id);
  if(idx>=0) { state.likedSongs.splice(idx,1); showToast('Beğenilenlerden çıkarıldı'); } else { state.likedSongs.unshift(track); showToast('Beğenilenlere eklendi ❤️'); }
  localStorage.setItem('spoflix_liked',JSON.stringify(state.likedSongs)); 
  updatePlayerUI(); updateLikedCountDisplay(); updateLikeButtons(track.id);
  if(state.currentView==='liked') renderLikedSongs();
}
function updateLikeButtons(trackId) {
  const isLiked = state.likedSongs.some(s => String(s.id) === String(trackId));
  const fill = isLiked ? 'currentColor' : 'none';
  document.querySelectorAll(`[data-track-id="${trackId}"] .track-like-btn, [data-track-id="${trackId}"] .card-like-btn, [data-track-id="${trackId}"] .youtube-trend-like`).forEach(btn => {
    btn.classList.toggle('liked', isLiked);
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', fill);
  });
}
function renderLikedSongs() {
  const c=document.getElementById('likedSongsList'),ce=document.getElementById('likedSongsCount'),pb=document.getElementById('playLikedBtn');
  ce.textContent=`${state.likedSongs.length} şarkı`;
  if(state.likedSongs.length===0) { pb.style.display='none'; c.innerHTML='<div class="empty-state"><div class="empty-state-icon">❤️</div><h3 class="empty-state-title">Beğendiğin şarkılar burada görünür</h3><p class="empty-state-text">Şarkıları beğenmeye başla, burada toplanacaklar.</p></div>'; return; }
  pb.style.display='inline-flex';
  c.innerHTML='<div class="track-list"><div class="track-list-header"><span>#</span><span>Başlık</span><span>Albüm</span><span>Süre</span></div>'+state.likedSongs.map((t,i)=>renderTrackListItem(t,i, 'liked')).join('')+'</div>';
}
function playLikedSongs() { if(state.likedSongs.length>0){ state.queue=[...state.likedSongs]; state.queueIndex=0; playTrack(state.queue[0]); } }
function updateLikedCountDisplay() { const el=document.getElementById('likedCount'); if(el) el.textContent=`${state.likedSongs.length} şarkı`; }
function addToRecentlyPlayed(track) { state.recentlyPlayed=state.recentlyPlayed.filter(t=>t.id!==track.id); state.recentlyPlayed.unshift(track); if(state.recentlyPlayed.length>50) state.recentlyPlayed=state.recentlyPlayed.slice(0,50); localStorage.setItem('spoflix_recent',JSON.stringify(state.recentlyPlayed)); }
function renderRecentlyPlayed() {
  const grid=document.getElementById('recentlyPlayedGrid');
  if(state.recentlyPlayed.length===0) { grid.innerHTML='<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">🎧</div><h3 class="empty-state-title">Henüz bir şey dinlemedin</h3><p class="empty-state-text">Müzik dinlemeye başla, son dinlediklerin burada görünecek.</p></div>'; return; }
  window._gridData_recentlyPlayedGrid=state.recentlyPlayed.slice(0,12);
  grid.innerHTML=state.recentlyPlayed.slice(0,12).map((t,i)=>renderTrackCard(t,i,'recentlyPlayedGrid')).join('');
}
function showToast(msg) { const t=document.getElementById('toast'); t.textContent=msg; t.classList.remove('tv-playback-error'); t.classList.add('show'); clearTimeout(t._timeout); t._timeout=setTimeout(()=>t.classList.remove('show'),2500); }
function showTvYoutubeFallback(track) {
  const toast = document.getElementById('toast');
  if (!toast || !track?.youtubeId) return;
  while (toast.firstChild) toast.removeChild(toast.firstChild);
  const message = document.createElement('span');
  message.textContent = 'Bu şarkı TV tarayıcısında gömülü çalınamadı.';
  const link = document.createElement('a');
  link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(track.youtubeId)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'tv-youtube-fallback';
  link.textContent = 'YouTube’da aç';
  toast.appendChild(message);
  toast.appendChild(link);
  toast.classList.add('show', 'tv-playback-error');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.remove('show', 'tv-playback-error'), 15000);
  setTimeout(() => link.focus(), 0);
}
function formatTime(s) { if(!s||isNaN(s)) return '0:00'; const m=Math.floor(s/60),sec=Math.floor(s%60); return m+':'+sec.toString().padStart(2,'0'); }
function escapeHtml(s) { if(!s) return ''; const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function createHeroParticles() { const c=document.getElementById('heroParticles'); if(!c) return; c.innerHTML=''; for(let i=0;i<20;i++){ const p=document.createElement('div'); p.className='hero-particle'; p.style.left=Math.random()*100+'%'; p.style.top=Math.random()*100+'%'; p.style.animationDelay=Math.random()*6+'s'; p.style.animationDuration=(4+Math.random()*4)+'s'; p.style.width=(2+Math.random()*4)+'px'; p.style.height=p.style.width; c.appendChild(p); } }
function applyTheme(themeName = 'dark') {
  const theme = themeName === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', theme === 'light');
  document.body.dataset.theme = theme;
  localStorage.setItem('spoflix_theme', theme);

  const themeIcon = document.getElementById('themeIcon');
  if (themeIcon) {
    themeIcon.innerHTML = theme === 'light'
      ? '<path d="M12 3.75a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V4.5a.75.75 0 0 1 .75-.75zm0 13.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5a.75.75 0 0 1 .75-.75zm7.5-6.75h-1.5a.75.75 0 0 1 0-1.5h1.5a.75.75 0 0 1 0 1.5zm-15 0h-1.5a.75.75 0 0 1 0-1.5h1.5a.75.75 0 0 1 0 1.5zm12.2 5.75 1.06-1.06a.75.75 0 1 1 1.06 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06zm-9.4-9.4 1.06-1.06a.75.75 0 1 1 1.06 1.06L9.36 6.36a.75.75 0 1 1-1.06-1.06zm0 9.4a.75.75 0 1 1 1.06 1.06L8.36 17.64a.75.75 0 1 1-1.06-1.06zm9.4-9.4a.75.75 0 1 1 1.06 1.06L17.64 8.36a.75.75 0 1 1-1.06-1.06zM12 7.5A4.5 4.5 0 1 1 12 16.5A4.5 4.5 0 0 1 12 7.5z"/>'
      : '<path d="M21 12.8A9 9 0 0 1 11.2 3a9 9 0 1 0 9.8 9.8z"/>';
  }
}

function toggleTheme() {
  const nextTheme = document.body.classList.contains('theme-light') ? 'dark' : 'light';
  applyTheme(nextTheme);
}

function initTheme() {
  try {
    const savedTheme = localStorage.getItem('spoflix_theme');
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(savedTheme || (prefersLight ? 'light' : 'dark'));
  } catch (e) {
    applyTheme('dark');
  }
}
function getAccount() {
  try { return JSON.parse(localStorage.getItem('spoflix_account') || 'null'); } catch (error) { return null; }
}
function updateAccountUI() {
  const account = getAccount();
  const name = document.getElementById('profileName');
  const status = document.getElementById('profileStatus');
  const initial = document.getElementById('profileInitial');
  const loginButton = document.getElementById('profileLoginButton');
  const logoutButton = document.getElementById('profileLogoutButton');
  if (!name || !status || !initial || !loginButton || !logoutButton) return;
  name.textContent = account?.name || 'Misafir';
  status.textContent = account ? 'Yerel hesap' : 'Hesap açılmadı';
  initial.textContent = (account?.name || 'U').charAt(0).toUpperCase();
  loginButton.hidden = Boolean(account);
  logoutButton.hidden = !account;
}
function toggleProfileMenu() {
  const menu = document.getElementById('profileMenu');
  const button = document.getElementById('profileButton');
  if (!menu || !button) return;
  menu.hidden = !menu.hidden;
  button.setAttribute('aria-expanded', String(!menu.hidden));
  updateAccountUI();
}
function openLogin() {
  document.getElementById('profileMenu').hidden = true;
  document.getElementById('loginModal').hidden = false;
  const error = document.getElementById('accountError');
  if (error) error.textContent = '';
  document.getElementById('accountName').focus();
}
function closeLogin() { document.getElementById('loginModal').hidden = true; }
function showAccountError(message) {
  const error = document.getElementById('accountError');
  if (error) error.textContent = message;
  showToast(message);
}
function login() {
  const name = document.getElementById('accountName').value.trim();
  const account = getAccount();
  if (!name) { showAccountError('Kullanıcı adını yaz.'); return; }
  if (!account || account.name.toLowerCase() !== name.toLowerCase()) {
    showAccountError('Bu kullanıcı bulunamadı. Önce Hesap oluştur butonuna bas.');
    return;
  }
  updateAccountUI();
  closeLogin();
  showToast(`Hoş geldin, ${name}`);
}
function createAccount() {
  const name = document.getElementById('accountName').value.trim();
  if (!name) { showAccountError('Hesap oluşturmak için kullanıcı adı yaz.'); return; }
  try {
    localStorage.setItem('spoflix_account', JSON.stringify({ name }));
    updateAccountUI();
    closeLogin();
    showToast(`${name} hesabı oluşturuldu.`);
  } catch (error) {
    showAccountError('Hesap kaydedilemedi. Tarayıcı depolama iznini kontrol et.');
  }
}
function logout() {
  localStorage.removeItem('spoflix_account');
  document.getElementById('profileMenu').hidden = true;
  updateAccountUI();
  showToast('Hesaptan çıkış yapıldı.');
}
function openSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.hidden = false;
  syncSettingsUI();
}
function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.hidden = true;
}
function syncSettingsUI() {
  const volume = document.getElementById('settingsVolume');
  const value = document.getElementById('settingsVolumeValue');
  const muteButton = document.getElementById('settingsMuteButton');
  const basePct = Math.round(state.volume * 100);
  const totalPct = state.isBoosted ? Math.round(basePct * state.boostMultiplier) : basePct;

  if (volume) volume.value = String(totalPct);
  if (value) {
    if (state.isMuted) value.textContent = 'Sessiz';
    else if (state.isBoosted || totalPct > 100) value.textContent = `${totalPct}% (Boost 🔥)`;
    else value.textContent = `${totalPct}%`;
  }
  if (muteButton) {
    muteButton.textContent = state.isMuted ? 'Açık' : 'Kapalı';
    muteButton.setAttribute('aria-pressed', String(state.isMuted));
  }
  updateAudioModeUI();
}

function setSettingsVolume(value) {
  const num = Number(value);
  initAudioEngine();
  state.isMuted = false;
  if (num > 100) {
    state.volume = 1.0;
    state.isBoosted = true;
    state.boostMultiplier = num / 100;
  } else {
    state.volume = Math.max(0, num / 100);
    state.isBoosted = false;
    state.boostMultiplier = 1.8;
  }
  applyVolumeSettings();
}

function toggleSettingsMute() {
  toggleMute();
  syncSettingsUI();
}
function setSettingsTheme(theme) {
  applyTheme(theme);
  showToast(theme === 'light' ? 'Açık tema seçildi.' : 'Koyu tema seçildi.');
}
function resetSettings() {
  setSettingsVolume(80);
  state.isMuted = false;
  applyTheme('dark');
  syncSettingsUI();
  showToast('Ayarlar sıfırlandı.');
}

// ── Ortak Klasör & Yükleme İşlemleri ──
function toggleSingleUploadForm() {
  const container = document.getElementById('singleUploadContainer');
  const icon = document.getElementById('uploadToggleIcon');
  if (!container) return;
  const isHidden = container.style.display === 'none' || !container.style.display;
  container.style.display = isHidden ? 'block' : 'none';
  if (icon) icon.textContent = isHidden ? '▲' : '▼';
}

function triggerFolderSelect() {
  const input = document.getElementById('folderAudioInput');
  if (input) input.click();
}

async function handleFolderSelect(input) {
  const files = Array.from(input.files || []);
  if (files.length === 0) return;

  const audioFiles = files.filter(f => {
    const ext = f.name.slice(((f.name.lastIndexOf('.') - 1) >>> 0) + 2).toLowerCase();
    return ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm'].includes(ext) || (f.type && f.type.startsWith('audio/'));
  });

  if (audioFiles.length === 0) {
    showToast('Seçilen klasörde ses (MP3/WAV vb.) dosyası bulunamadı.');
    input.value = '';
    return;
  }

  const progress = document.getElementById('folderUploadProgress');
  const progressText = document.getElementById('folderProgressText');
  const progressCount = document.getElementById('folderProgressCount');
  const progressFill = document.getElementById('folderProgressFill');

  if (progress) progress.style.display = 'block';
  showToast(`${audioFiles.length} şarkı taranıyor ve aktarılıyor...`);

  let addedCount = 0;
  for (let i = 0; i < audioFiles.length; i++) {
    const file = audioFiles[i];
    try {
      let baseName = file.name.replace(/\.[^/.]+$/, "").trim();
      baseName = baseName.replace(/^\d+[\s.-]+/, '').trim();

      let artist = 'Ortak Sanatçı';
      let title = baseName;

      if (baseName.includes(' - ')) {
        const parts = baseName.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      } else if (baseName.includes(' – ')) {
        const parts = baseName.split(' – ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' – ').trim();
      }

      const audioBlob = await fileToBlob(file);
      const duration = await getAudioDuration(file);
      const art = getDefaultArtwork();

      await saveSongToDB({
        name: title || file.name,
        artist: artist || 'Ortak Sanatçı',
        album: 'Ortak Klasör',
        artwork: art,
        artworkSmall: art,
        audioBlob: audioBlob,
        duration: duration || 0
      });
      addedCount++;
    } catch (err) {
      console.warn(`Dosya kaydedilemedi (${file.name}):`, err);
    }

    const pct = Math.round(((i + 1) / audioFiles.length) * 100);
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressCount) progressCount.textContent = `${pct}%`;
    if (progressText) progressText.textContent = `${i + 1} / ${audioFiles.length} şarkı aktarıldı...`;
  }

  if (progress) progress.style.display = 'none';
  input.value = '';
  showToast(`${addedCount} şarkı Ortak Klasör'e eklendi! 🎉`);
  await loadMySongsFromDB();
  renderMySongs();
}

function playAllCustomSongs() {
  if (state.mySongs.length > 0) {
    state.queue = [...state.mySongs];
    state.queueIndex = 0;
    playTrack(state.queue[0]);
  } else {
    showToast('Ortak klasörde henüz şarkı yok.');
  }
}

async function exportSharedFolder() {
  try {
    const songs = await getSongsFromDB();
    if (!songs || songs.length === 0) {
      showToast('Dışa aktarılacak şarkı bulunamadı.');
      return;
    }
    showToast('Ortak klasör paketi hazırlanıyor...');
    const exportData = [];
    for (const s of songs) {
      const b64 = await new Promise((res) => {
        const reader = new FileReader();
        reader.onloadend = () => res(reader.result);
        reader.readAsDataURL(s.audioBlob);
      });
      exportData.push({
        name: s.name,
        artist: s.artist,
        album: s.album || 'Ortak Klasör',
        artwork: s.artwork,
        artworkSmall: s.artworkSmall,
        duration: s.duration,
        audioData: b64
      });
    }
    const jsonStr = JSON.stringify({ app: 'SpoFlix', version: 1, exportDate: new Date().toISOString(), songs: exportData });
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spoflix_ortak_klasor_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Ortak Klasör paketi indirildi 📥');
  } catch (err) {
    console.error('Export error:', err);
    showToast('Dışa aktarma sırasında hata oluştu.');
  }
}

function triggerImportSharedFolder() {
  const input = document.getElementById('importSharedInput');
  if (input) input.click();
}

async function handleImportSharedFolder(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  showToast('Ortak klasör paketi okunuyor...');
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const songs = Array.isArray(parsed) ? parsed : (parsed.songs || []);
    if (songs.length === 0) {
      showToast('Paket içinde şarkı bulunamadı.');
      input.value = '';
      return;
    }
    let importedCount = 0;
    for (const s of songs) {
      let audioBlob = null;
      if (s.audioData) {
        const res = await fetch(s.audioData);
        audioBlob = await res.blob();
      } else if (s.audioBlob) {
        audioBlob = s.audioBlob;
      }
      if (audioBlob) {
        await saveSongToDB({
          name: s.name,
          artist: s.artist,
          album: s.album || 'Ortak Klasör',
          artwork: s.artwork || getDefaultArtwork(),
          artworkSmall: s.artworkSmall || getDefaultArtwork(),
          audioBlob: audioBlob,
          duration: s.duration || 0
        });
        importedCount++;
      }
    }
    input.value = '';
    showToast(`${importedCount} şarkı Ortak Klasör'e içe aktarıldı! 🎉`);
    await loadMySongsFromDB();
    renderMySongs();
  } catch (err) {
    console.error('Import error:', err);
    showToast('Paket içe aktarılırken hata oluştu.');
    input.value = '';
  }
}

function handleFileSelect(input,labelId) { document.getElementById(labelId).textContent=input.files&&input.files[0]?input.files[0].name:'Seçilmedi'; }
function getAudioDuration(file) { return new Promise((resolve)=>{const u=URL.createObjectURL(file),ta=new Audio(u);ta.addEventListener('loadedmetadata',()=>{resolve(Math.round(ta.duration));URL.revokeObjectURL(u);});ta.addEventListener('error',()=>{resolve(0);URL.revokeObjectURL(u);});}); }
function fileToBlob(file) { return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=e=>resolve(new Blob([e.target.result],{type:file.type}));r.onerror=e=>reject(e);r.readAsArrayBuffer(file);}); }

async function handleSongUpload(e) {
  e.preventDefault(); const title=document.getElementById('songTitle').value.trim(),artist=document.getElementById('songArtist').value.trim(),af=document.getElementById('songAudioFile').files[0],cf=document.getElementById('songCoverFile').files[0];
  if(!af){showToast('Lütfen bir ses dosyası seçin!');return;} showToast('Şarkı işleniyor...');
  try {
    const ab=await fileToBlob(af); let art=getDefaultArtwork();
    if(cf){ const cb=await fileToBlob(cf); art=await new Promise((resolve)=>{const r=new FileReader();r.onloadend=()=>resolve(r.result);r.readAsDataURL(cb);}); }
    const dur=await getAudioDuration(af); await saveSongToDB({name:title,artist:artist,album:'Ortak Klasör',artwork:art,artworkSmall:art,audioBlob:ab,duration:dur});
    showToast('Şarkı eklendi! 🎉'); document.getElementById('uploadForm').reset(); document.getElementById('audioFileName').textContent='Seçilmedi'; document.getElementById('coverFileName').textContent='Seçilmedi';
    await loadMySongsFromDB(); renderMySongs();
  } catch(err){console.error('Upload error:',err);showToast('Şarkı yüklenirken hata oluştu.');}
}
async function loadMySongsFromDB() { try { const songs=await getSongsFromDB(); state.mySongs=songs.map(s=>{const u=URL.createObjectURL(s.audioBlob);return{id:'local_'+s.id,dbId:s.id,name:s.name,artist:s.artist,album:s.album||'Ortak Klasör',artwork:s.artwork,artworkSmall:s.artworkSmall,previewUrl:u,duration:s.duration};}); } catch(err){console.error('Load custom songs error:',err);} }

function renderMySongs() {
  const c=document.getElementById('mySongsList'); 
  const ce=document.getElementById('mySongsCount'); 
  const playAllBtn = document.getElementById('playAllCustomBtn');
  if (ce) ce.textContent=state.mySongs.length+' şarkı';
  if (playAllBtn) playAllBtn.style.display = state.mySongs.length > 0 ? 'inline-flex' : 'none';
  if(!c) return;
  if(state.mySongs.length===0){ 
    c.innerHTML='<div class="empty-state" style="padding:40px 0;"><div class="empty-state-icon">📂</div><h3 class="empty-state-title">Ortak klasörde henüz şarkı yok</h3><p class="empty-state-text">Yukarıdaki "Ortak Klasör Seç" butonuna basarak bilgisayarından veya telefonundan bir müzik klasörü ekle!</p></div>'; 
    return; 
  }
  const html=state.mySongs.map((track,i)=>{
    const ip=state.currentTrack&&state.currentTrack.id===track.id;
    const il=state.likedSongs.some(s=>s.id===track.id);
    const d=formatTime(track.duration);
    const isPlayingIcon=ip&&state.isPlaying?'<div class="equalizer"><div class="equalizer-bar"></div><div class="equalizer-bar"></div><div class="equalizer-bar"></div><div class="equalizer-bar"></div></div>':'<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    const likeFill=il?'currentColor':'none';
    const trackIdStr = String(track.id).replace(/'/g, "\\'");
    return `<div class="track-list-item ${ip?'playing':''}" onclick="playFromContext('mySongs', ${i})" data-track-id="${track.id}"><div><span class="track-list-number">${i+1}</span><span class="track-list-play-icon">${isPlayingIcon}</span></div><div class="track-list-info"><div class="track-list-art"><img src="${track.artwork}" alt="" loading="lazy"></div><div class="track-list-text"><div class="track-list-name">${escapeHtml(track.name)}</div><div class="track-list-artist">${escapeHtml(track.artist)}</div></div></div><div class="track-list-album">${escapeHtml(track.album||'')}</div><div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;"><button class="track-like-btn ${il?'liked':''}" onclick="event.stopPropagation();toggleLikeById('${trackIdStr}')" title="Beğen"><svg width="16" height="16" viewBox="0 0 24 24" fill="${likeFill}" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></button><button class="track-delete-btn" onclick="event.stopPropagation();removeCustomSong(${track.dbId})" title="Sil"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button><span class="track-list-duration">${d}</span></div></div>`;
  }).join('');
  c.innerHTML='<div class="track-list"><div class="track-list-header"><span>#</span><span>Başlık</span><span>Albüm</span><span>Süre</span></div>'+html+'</div>';
}
async function removeCustomSong(dbId) {
  try {
    await deleteSongFromDB(dbId); showToast('Şarkı başarıyla silindi 🗑️');
    await loadMySongsFromDB(); renderMySongs();
    if (state.currentTrack && state.currentTrack.dbId === dbId) { audio.pause(); state.isPlaying = false; updatePlayerUI(); }
  } catch (err) { console.error('Delete error:', err); showToast('Şarkı silinirken bir hata oluştu.'); }
}
async function initApp() {
  initializeTvControls();
  createHeroParticles();
  initTheme();
  updateAudioModeUI();
  try { state.lyricOffsets = JSON.parse(localStorage.getItem('spoflix_lyric_offsets') || '{}'); } catch (error) { state.lyricOffsets = {}; }
  updateAccountUI();
  try { await initDatabase(); await loadMySongsFromDB(); } catch(e) { console.error('DB init failed:',e); }
  const grid = document.getElementById('turkeyTrendGrid');
  if (grid) grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  state.youtubeTrendingTracks = await getYouTubeTrendingTracks(25);
  if (grid) {
    grid.innerHTML = state.youtubeTrendingTracks.length
      ? renderYouTubeTrendingList(state.youtubeTrendingTracks)
      : '<p class="youtube-trend-empty">YouTube Türkiye trendleri şu anda yüklenemedi.</p>';
  }
  if (isTvBrowser) setTimeout(() => focusFirstTvElement('home'), 0);
  updateLikedCountDisplay();
  applyVolumeSettings();
}
document.addEventListener('keydown',(e)=>{
  if (handleTvRemoteKey(e)) return;
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  switch(e.code) {
    case 'Space': e.preventDefault(); togglePlayPause(); break;
    case 'ArrowRight': if(e.shiftKey) playNext(); else audio.currentTime=Math.min(audio.currentTime+5,audio.duration); break;
    case 'ArrowLeft': if(e.shiftKey) playPrev(); else audio.currentTime=Math.max(audio.currentTime-5,0); break;
    case 'ArrowUp': e.preventDefault(); initAudioEngine(); state.volume=Math.min(1.0, state.volume+0.05); state.isMuted=false; applyVolumeSettings(); break;
    case 'ArrowDown': e.preventDefault(); initAudioEngine(); state.volume=Math.max(0, state.volume-0.05); state.isMuted=false; applyVolumeSettings(); break;
    case 'KeyB': e.preventDefault(); toggleBoost(); break;
    case 'KeyM': toggleMute(); break;
    case 'KeyS': if(e.ctrlKey){ e.preventDefault(); navigateTo('search'); } break;
  }
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
else initApp();

// İlk kullanıcı etkileşiminde Web Audio API AudioContext'ini anında uyandır
const unlockAudioOnGesture = () => {
  initAudioEngine();
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
};
document.addEventListener('click', unlockAudioOnGesture, { once: true, passive: true });
document.addEventListener('keydown', unlockAudioOnGesture, { once: true, passive: true });
document.addEventListener('touchstart', unlockAudioOnGesture, { once: true, passive: true });

// Menü dışına tıklandığında ses modları dropdown'ını kapat
document.addEventListener('click', (e) => {
  const headerMenu = document.getElementById('headerAudioModesMenu');
  const headerBtn = document.getElementById('headerAudioModesBtn');
  if (headerMenu && !headerMenu.hidden && !headerMenu.contains(e.target) && !headerBtn?.contains(e.target)) {
    headerMenu.hidden = true;
  }
});
// ── 1. YOUTUBE FALLBACK PLAYER SİSTEMİ ──
let ytPlayer = null;
let ytPlayerReady = false;
let ytTimeInterval = null;
let pendingYoutubeTrack = null;

const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

function onYouTubeIframeAPIReady() {
  const ytContainer = document.createElement('div');
  ytContainer.id = 'ytplayer-container';
  ytContainer.style.position = 'fixed';
  ytContainer.style.left = '-20000px';
  ytContainer.style.top = '-20000px';
  ytContainer.style.width = '200px';
  ytContainer.style.height = '200px';
  document.body.appendChild(ytContainer);

  ytPlayer = new YT.Player('ytplayer-container', {
    height: '200',
    width: '200',
    videoId: '',
    playerVars: { 'autoplay': 1, 'controls': 0, 'disablekb': 1, 'playsinline': 1, 'origin': window.location.origin },
    events: {
      'onReady': () => { 
        ytPlayerReady = true; 
        ytPlayer.unMute();
        ytPlayer.setVolume(state.isMuted ? 0 : state.volume * 100); 
        const pendingTrack = pendingYoutubeTrack;
        pendingYoutubeTrack = null;
        if (pendingTrack && state.currentTrack?.id === pendingTrack.id) playTrack(pendingTrack);
      },
      'onStateChange': onYtPlayerStateChange,
      'onError': (event) => {
        const expectedVideoId = state.currentTrack?.youtubeId;
        const failedVideoId = event.target?.getVideoData?.().video_id;
        if (!expectedVideoId || (failedVideoId && failedVideoId !== expectedVideoId)) return;
        clearInterval(ytTimeInterval);
        state.isPlaying = false;
        updatePlayerUI();
        if (isTvBrowser) showTvYoutubeFallback(state.currentTrack);
        else showToast('Bu şarkı YouTube üzerinden oynatılamıyor. Başka bir şarkı seç.');
      },
      'onAutoplayBlocked': () => {
        if (isTvBrowser && state.currentTrack?.youtubeId) showTvYoutubeFallback(state.currentTrack);
      },
    }
  });
  const hideYouTubePlayer = () => {
    const frame = document.getElementById('ytplayer-container');
    if (!frame) return;
    frame.style.setProperty('position', 'fixed', 'important');
    frame.style.setProperty('left', '-20000px', 'important');
    frame.style.setProperty('top', '-20000px', 'important');
    frame.style.setProperty('width', '200px', 'important');
    frame.style.setProperty('height', '200px', 'important');
    frame.style.setProperty('opacity', '0', 'important');
    frame.style.setProperty('pointer-events', 'none', 'important');
  };
  hideYouTubePlayer();
  setInterval(hideYouTubePlayer, 1000);
}

function onYtPlayerStateChange(event) {
  const expectedVideoId = state.currentTrack?.youtubeId;
  const eventVideoId = event.target?.getVideoData?.().video_id;
  if (!expectedVideoId || (eventVideoId && eventVideoId !== expectedVideoId)) return;

  if (event.data === YT.PlayerState.PLAYING) {
    state.audioReady = true;
    state.isPlaying = true;
    if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(state.audioMode === 'nightcore' ? 1.25 : 1);
    document.getElementById('totalTime').textContent = formatTime(ytPlayer.getDuration());
    applyVolumeSettings();
    
    clearInterval(ytTimeInterval);
    ytTimeInterval = setInterval(() => {
      if(!state.isSeeking && state.isPlaying && state.playbackMode === 'youtube') {
        const c = ytPlayer.getCurrentTime();
        const d = ytPlayer.getDuration();
        if(d > 0) {
          document.getElementById('progressFill').style.width = `${(c/d)*100}%`;
          document.getElementById('currentTime').textContent = formatTime(c);
        }
        syncLyrics(c);
      }
    }, 500);
  } else if (event.data === YT.PlayerState.ENDED) {
    clearInterval(ytTimeInterval);
    playNext();
  } else if (event.data === YT.PlayerState.PAUSED) {
    state.isPlaying = false;
  }
}

// ── 2. OYNATMA VE KONTROL FONKSİYONLARI ──
function stopCurrentPlayback() {
  audio.pause();
  if (ytPlayerReady && ytPlayer?.stopVideo) ytPlayer.stopVideo();
  clearInterval(ytTimeInterval);
  state.isPlaying = false;
  state.audioReady = false;
  document.getElementById('currentTime').textContent = '0:00';
  document.getElementById('totalTime').textContent = '0:00';
  document.getElementById('progressFill').style.width = '0%';
}

function playTrack(track) {
  if(!track) {
    state.errorCount++;
    if(state.errorCount < state.maxErrors) setTimeout(() => playNext(), 500);
    return;
  }
  pendingYoutubeTrack = null;

  // Her çağrıya benzersiz bir "token" ver. audio.play() gibi asenkron
  // işlemler tamamlandığında token hala en güncel mi diye kontrol edilecek.
  // Böylece araya başka bir şarkı seçimi girdiyse (kullanıcı hızlı tıkladıysa),
  // eski/bayat isteğin sonucu yeni şarkının üzerine yazamaz.
  const myToken = ++state.playToken;
  stopCurrentPlayback();

  state.currentTrack = track; 
  state.audioReady = false; 
  state.trackStartTime = Date.now();
  state.lyricLines = [];
  state.lyricTrackId = track.id;
  state.activeLyricIndex = -1;
  const lyricsPanel = document.getElementById('lyricsPanel');
  if (lyricsPanel?.classList.contains('open')) {
    loadLyricsForTrack(track);
  }
  
  const shouldPlay = true;
  initAudioEngine();
  applyAudioModeSettings();
  applyVolumeSettings();
  
  if (track.previewUrl) {
    state.playbackMode = 'audio';
    let audioSrc = track.previewUrl;
    if ((audioSrc.startsWith('http://') || audioSrc.startsWith('https://')) && !audioSrc.includes('/api/stream')) {
      audioSrc = '/api/stream?url=' + encodeURIComponent(track.previewUrl);
    }
    audio.src = audioSrc;
    audio.currentTime = 0;
    if (shouldPlay) {
      audio.play().then(() => {
        if (myToken !== state.playToken) return;
        state.isPlaying = true;
        startAudioMotion();
        updatePlayerUI();
        updatePlayingStates();
      }).catch(e => {
        if (myToken !== state.playToken) return;
        console.warn('audio.play() failed:', e);
        state.isPlaying = false;
        updatePlayerUI();
      });
      state.isPlaying = true;
    }
  } else if (ytPlayerReady && ytPlayer) {
    state.playbackMode = 'youtube';
    document.getElementById("totalTime").textContent = "0:00";
    document.getElementById("currentTime").textContent = "0:00";
    document.getElementById("progressFill").style.width = "0%";
    
    if (!track.youtubeId) {
      state.isPlaying = false;
      showToast('Bu şarkı için YouTube videosu bulunamadı.');
      updatePlayerUI();
      updatePlayingStates();
      return;
    }
    ytPlayer.loadVideoById(track.youtubeId);
    ytPlayer.unMute();
    ytPlayer.setVolume(state.isMuted ? 0 : Math.min(100, state.volume * 100));
    if (shouldPlay) {
      ytPlayer.playVideo();
      state.isPlaying = true;
    }
  } else if (track.youtubeId) {
    state.playbackMode = 'youtube';
    state.isPlaying = false;
    pendingYoutubeTrack = track;
    showToast('YouTube oynatıcı hazırlanıyor...');
    updatePlayerUI();
    updatePlayingStates();
    setTimeout(() => {
      if (pendingYoutubeTrack?.id === track.id && state.currentTrack?.id === track.id) {
        pendingYoutubeTrack = null;
        showToast('YouTube oynatıcı hazır değil. Biraz sonra tekrar dene.');
        updatePlayerUI();
      }
    }, 10000);
  } else {
    state.playbackMode = 'audio';
    state.isPlaying = false;
    showToast('Bu şarkı için oynatılabilir kaynak bulunamadı.');
    updatePlayerUI();
  }
  updatePlayerUI(); 
  addToRecentlyPlayed(track); 
  updatePlayingStates();
}

function togglePlayPause() {
  if(!state.currentTrack) { 
    if(state.queue.length > 0) playTrack(state.queue[0]); 
    return; 
  }
  
  if(state.isPlaying) { 
    if(state.playbackMode === 'youtube' && ytPlayer) ytPlayer.pauseVideo();
    else audio.pause(); 
    state.isPlaying = false; 
    document.documentElement.style.setProperty('--audio-level', '0.08');
  } else { 
    initAudioEngine();
    if(state.playbackMode === 'youtube' && ytPlayer) ytPlayer.playVideo();
    else audio.play().catch(e => console.warn('Play error:', e)); 
    state.isPlaying = true; 
    startAudioMotion();
  }
  updatePlayerUI(); 
  updatePlayingStates();
}

function seekTo(e) {
  if(!state.currentTrack) return;
  const bar = document.getElementById('progressBar');
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const cx = getEventClientX(e);
  const ratio = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
  
  if(state.playbackMode === 'youtube' && ytPlayer) {
    ytPlayer.seekTo(ratio * ytPlayer.getDuration(), true);
  } else {
    audio.currentTime = ratio * (audio.duration || 0);
  }
}

// ── 3. SES VE İLERLEME ÇUBUĞU (PROGRESS BAR) GÜNCELLEMELERİ ──
function updateVolumeFromEvent(e) {
  const bar = document.getElementById('volumeBar');
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const cx = getEventClientX(e);
  const ratio = Math.max(0, Math.min(1.0, (cx - rect.left) / rect.width));
  
  initAudioEngine();
  state.volume = ratio; 
  state.isMuted = false; 
  applyVolumeSettings();
}

function toggleMute() {
  initAudioEngine();
  state.isMuted = !state.isMuted;
  applyVolumeSettings();
}

function updateVolumeIcon() {
  const high = document.getElementById('iconVolumeHigh');
  const mute = document.getElementById('iconVolumeMuted');
  const isSilent = state.isMuted || state.volume === 0;
  if (high) high.style.display = isSilent ? 'none' : 'block';
  if (mute) mute.style.display = isSilent ? 'block' : 'none';
}

function updateVolumeUI() {
  const badge = document.getElementById('volumeBadge');
  const boostBtn = document.getElementById('btnPlayerBoost');
  const fill = document.getElementById('volumeFill');
  const basePct = Math.round(state.volume * 100);

  if (fill) {
    fill.style.width = state.isMuted ? '0%' : `${basePct}%`;
  }

  if (badge) {
    if (state.isMuted) {
      badge.textContent = 'MUTE';
      badge.classList.remove('boosted');
    } else if (state.isBoosted) {
      const modeExtra = state.audioMode === 'boost' ? 1.35 : 1.0;
      const boostedVal = Math.round(basePct * state.boostMultiplier * modeExtra);
      badge.textContent = `🔥 ${boostedVal}%`;
      badge.classList.add('boosted');
    } else {
      badge.textContent = `${basePct}%`;
      badge.classList.remove('boosted');
    }
  }

  if (boostBtn) {
    boostBtn.classList.toggle('active', state.isBoosted);
  }

  updateVolumeIcon();
  syncSettingsUI();
}

audio.addEventListener('timeupdate', () => { 
  if(state.isSeeking || state.playbackMode === 'youtube') return; 
  const c = audio.currentTime;
  const d = audio.duration || 0; 
  if(d > 0){ 
    document.getElementById('progressFill').style.width = `${(c / d) * 100}%`; 
    document.getElementById('currentTime').textContent = formatTime(c); 
    document.getElementById('totalTime').textContent = formatTime(d); 

    // Kilit ekranı / bildirim çubuğu süre göstergesi
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && c <= d) {
      try {
        navigator.mediaSession.setPositionState({
          duration: d,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(c, d)
        });
      } catch(e) {}
    }
  }
  syncLyrics(c);
});

// Sayfa arka plana geçtiğinde ve geri geldiğinde ses motoru koruması
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  }
});
