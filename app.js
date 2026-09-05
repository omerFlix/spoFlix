/* ============================================
   SPOFLIX - Premium Music Streaming App
   ============================================ */

// ── State ──
const state = {
  currentView: 'home', currentTrack: null, queue: [], queueIndex: -1,
  isPlaying: false, isShuffle: false, repeatMode: 0, volume: 0.8, isMuted: false,
  errorCount: 0, maxErrors: 5, trackStartTime: 0, audioReady: false,
  likedSongs: JSON.parse(localStorage.getItem('spoflix_liked') || '[]'),
  recentlyPlayed: JSON.parse(localStorage.getItem('spoflix_recent') || '[]'),
  mySongs: [], searchTimeout: null, currentPlaylistTracks: [], isSeeking: false,
  playbackMode: 'audio',
  audiusHost: null, currentGenre: null, isLoadingMore: false, loadedTrackIds: new Set(),
  playToken: 0,
  lyricLines: [], lyricTrackId: null, activeLyricIndex: -1, lyricRequestId: 0, lyricOffsets: {},
  nightcoreOn: localStorage.getItem('spoflix_nightcore') === 'true',
  boostGain: parseFloat(localStorage.getItem('spoflix_boost') || '1'),
};

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

// ── Audio Player ──
const audio = new Audio();
audio.volume = state.volume;
audio.setAttribute('playsinline', '');
audio.setAttribute('webkit-playsinline', '');
audio.preload = 'auto';
let audioContext = null;
let audioAnalyser = null;
let audioSource = null;
let audioMotionFrame = null;
let audioModeInput = null;
let bassFilter = null;
let stereoPanner = null;
let boostGainNode = null;
const MAX_BOOST = 1.5;

function connectAudioMode() {
  if (!audioSource || !audioAnalyser) return;
  audioSource.disconnect();
  audioAnalyser.disconnect();
  if (audioModeInput) audioModeInput.disconnect();
  if (bassFilter) bassFilter.disconnect();
  if (stereoPanner) stereoPanner.disconnect();
  if (boostGainNode) boostGainNode.disconnect();

  audioModeInput = audioContext.createGain();
  bassFilter = audioContext.createBiquadFilter();
  stereoPanner = audioContext.createStereoPanner();
  boostGainNode = audioContext.createGain();
  bassFilter.type = 'lowshelf';
  bassFilter.frequency.value = 180;
  bassFilter.gain.value = 0;
  stereoPanner.pan.value = 0;
  boostGainNode.gain.value = state.boostGain;

  audioSource.connect(audioModeInput);
  audioModeInput.connect(boostGainNode);
  boostGainNode.connect(audioAnalyser);
  audioAnalyser.connect(audioContext.destination);
  audio.playbackRate = state.nightcoreOn ? 1.15 : 1;
}

function toggleAudioModes() {
  const panel = document.getElementById('audioModesPanel');
  const button = document.querySelector('.modes-nav');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  button?.setAttribute('aria-expanded', String(!panel.hidden));
  updateAudioModeUI();
}

function updateAudioModeUI() {
  const toggle = document.getElementById('nightcoreToggle');
  if (toggle) {
    toggle.classList.toggle('active', state.nightcoreOn);
    toggle.setAttribute('aria-pressed', String(state.nightcoreOn));
  }
  const boostSlider = document.getElementById('boostSlider');
  const boostFill = document.getElementById('boostFill');
  const boostValue = document.getElementById('boostValue');
  if (boostSlider) boostSlider.value = Math.round(state.boostGain * 100);
  if (boostFill) boostFill.style.width = `${(state.boostGain / MAX_BOOST) * 100}%`;
  if (boostValue) boostValue.textContent = `${Math.round(state.boostGain * 100)}%`;
}

function toggleNightcore() {
  state.nightcoreOn = !state.nightcoreOn;
  localStorage.setItem('spoflix_nightcore', String(state.nightcoreOn));
  if (state.playbackMode === 'youtube' && ytPlayer) {
    if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(state.nightcoreOn ? 1.25 : 1);
  } else if (audioContext) {
    audio.playbackRate = state.nightcoreOn ? 1.15 : 1;
  } else {
    audio.playbackRate = state.nightcoreOn ? 1.15 : 1;
  }
  updateAudioModeUI();
  showToast(state.nightcoreOn ? 'Nightcore açık' : 'Nightcore kapalı');
}

function setBoostGain(percent) {
  const clamped = Math.max(50, Math.min(150, percent));
  state.boostGain = clamped / 100;
  localStorage.setItem('spoflix_boost', String(state.boostGain));
  if (boostGainNode) {
    boostGainNode.gain.setTargetAtTime(state.boostGain, audioContext.currentTime, 0.05);
  }
  updateAudioModeUI();
}

function startAudioMotion() {
  if (!audioAnalyser) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioAnalyser = audioContext.createAnalyser();
      audioAnalyser.fftSize = 128;
      audioSource = audioContext.createMediaElementSource(audio);
      connectAudioMode();
    } catch (error) {
      audioAnalyser = null;
    }
  }
  audioContext?.resume?.();
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
function getDefaultArtwork() { return 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23242438" width="100" height="100"/><text y="60" x="30" font-size="40">🎵</text></svg>'; }
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
  return { id:'audius_'+track.id, name:track.title||'Bilinmeyen Şarkı', artist:track.user?.name||'Bilinmeyen Sanatçı', album:track.album||track.genre||'Single', artwork:art['480x480']||art['150x150']||getDefaultArtwork(), artworkSmall:art['150x150']||art['480x480']||getDefaultArtwork(), previewUrl:url, duration:track.duration||0, genre:track.genre||'', isFullSong:true };
}
function mapITunesTrack(track) {
  const l=track.artworkUrl100?track.artworkUrl100.replace('100x100','600x600'):getDefaultArtwork(),s=track.artworkUrl100||getDefaultArtwork();
  return { id:'itunes_'+track.trackId, name:track.trackName||'Bilinmeyen Şarkı', artist:track.artistName||'Bilinmeyen Sanatçı', album:track.collectionName||'Single', artwork:l, artworkSmall:s, previewUrl:track.previewUrl||'', duration:Math.round((track.trackTimeMillis||0)/1000), genre:track.primaryGenreName||'', isFullSong:false };
}
async function searchITunes(q,l=25) {
  try { const r=await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${l}`); if(!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()).results.map(mapITunesTrack); } catch(e) { console.error('iTunes error:',e); return []; }
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
      artwork: t.album_image || getDefaultArtwork(),
      artworkSmall: t.album_image || getDefaultArtwork(),
      previewUrl: t.audio,
      duration: t.duration || 0,
      genre: t.musicinfo?.tags?.genres?.join(', ') || '',
      isFullSong: true
    }));
  } catch (e) { console.error('Jamendo error:', e); return []; }
}
const YOUTUBE_DATA_API_KEY = 'AIzaSyDUg41_G8SEQZGu9y44Si69VaG3SLX4qMY';
async function searchYouTube(q,l=10) {
  if (!YOUTUBE_DATA_API_KEY || YOUTUBE_DATA_API_KEY === 'YOUR_YOUTUBE_DATA_API_KEY') return [];
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet'); url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', l); url.searchParams.set('q', q); url.searchParams.set('key', YOUTUBE_DATA_API_KEY);
    const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).items.filter(item => item.id?.videoId).map(item => ({
      id: 'youtube_' + item.id.videoId, youtubeId: item.id.videoId, name: item.snippet.title,
      artist: item.snippet.channelTitle, album: 'YouTube', artwork: item.snippet.thumbnails?.high?.url || getDefaultArtwork(),
      artworkSmall: item.snippet.thumbnails?.medium?.url || getDefaultArtwork(), previewUrl: '', duration: 0, isFullSong: true
    }));
  } catch (e) { console.error('YouTube search error:', e); return []; }
}
function searchDeezer(q,l=25) {
  return new Promise((resolve)=>{
    const cb='deezer_cb_'+Date.now()+'_'+Math.floor(Math.random()*100000),s=document.createElement('script');
    window[cb]=(d)=>{ delete window[cb]; if(s.parentNode) s.parentNode.removeChild(s); if(d&&d.data) resolve(d.data.slice(0,l).map(t=>({ id:'deezer_'+t.id, name:t.title||'Bilinmeyen Şarkı', artist:t.artist?.name||'Bilinmeyen Sanatçı', album:t.album?.title||'Single', artwork:t.album?.cover_xl||t.album?.cover_medium||getDefaultArtwork(), artworkSmall:t.album?.cover_small||t.album?.cover_medium||getDefaultArtwork(), previewUrl:t.preview||'', duration:t.duration||0, genre:'', isFullSong:false }))); else resolve([]); };
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
}
function updateBgGradient(v) {
  const g=document.getElementById('mainBgGradient'),grads={home:'linear-gradient(180deg,rgba(29,185,84,0.15)0%,transparent 100%)',search:'linear-gradient(180deg,rgba(124,58,237,0.15)0%,transparent 100%)',library:'linear-gradient(180deg,rgba(59,130,246,0.15)0%,transparent 100%)',liked:'linear-gradient(180deg,rgba(124,58,237,0.2)0%,transparent 100%)',playlist:'linear-gradient(180deg,rgba(29,185,84,0.2)0%,transparent 100%)',upload:'linear-gradient(180deg,rgba(233,30,140,0.15)0%,transparent 100%)'};
  g.style.background=grads[v]||grads.home;
}

// ── Search ──
function handleSearch(q) {
  clearTimeout(state.searchTimeout);
  const si = document.getElementById('searchInput');
  const spi = document.getElementById('searchPageInput');
  if (si && si.value !== q) si.value = q;
  if (spi && spi.value !== q) spi.value = q;
  if(state.currentView!=='search'){ navigateTo('search'); }
  const rd=document.getElementById('searchResults'); if(!rd) return;
  if(q.length<2){ rd.innerHTML='<div class="section-header"><h2 class="section-title">Popüler Aramalar</h2></div><div class="genre-grid" id="searchGenreGrid"></div>'; populateSearchGenres(); return; }
  state.searchTimeout=setTimeout(async()=>{
    rd.innerHTML='<div class="loading-spinner"><div class="spinner"></div></div>';
    const [yR,jR,iR,dR,aR]=await Promise.all([searchYouTube(q,10),searchJamendo(q,25),searchITunes(q,25),searchDeezer(q,25),searchAudius(q,25)]);
    const ql=q.toLowerCase().trim();
    const n=(s)=>(s||'').toLowerCase().replace(/[\s\p{P}\p{M}]/gu,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const qn=n(ql);
    const isSub=(qt,t)=>{ let qi=0; for(let ti=0;ti<t.length&&qi<qt.length;ti++){ if(t[ti]===qt[qi]) qi++; } return qi===qt.length; };
    const score=(t)=>{ const a=(t.artist||'').toLowerCase(),nm=(t.name||'').toLowerCase(),an=n(a),nn=n(nm); if(a===ql)return 6; if(an===qn)return 5; if(a.includes(ql))return 4; if(an.includes(qn))return 3; if(isSub(qn,an))return 2; if(nm.includes(ql)||nn.includes(qn))return 1; return 0; };
    const fs=(t)=>t.map(t=>({track:t,score:score(t)})).filter(s=>s.score>0).sort((a,b)=>b.score-a.score).map(s=>s.track);
    const fY=yR,fJ=fs(jR),fI=fs(iR),fD=fs(dR),fA=fs(aR);
    const seen=new Set(); let tracks=[...fA,...fJ,...fY,...fD,...fI].filter(t=>{const k=`${(t.artist||'').toLowerCase()}|${(t.name||'').toLowerCase()}`;if(seen.has(k))return false;seen.add(k);return true;});
    tracks = tracks.filter(t => t.isFullSong || t.id.startsWith('local_'));
    if(tracks.length===0){ rd.innerHTML='<div class="empty-state"><div class="empty-state-icon">🎧</div><h3 class="empty-state-title">Tam sürüm bulunamadı</h3><p class="empty-state-text">"'+escapeHtml(q)+'" için yalnızca kısa önizlemeler bulundu. Tam sürüm için Audius kaynağı gerekiyor.</p></div>'; return; }
    state.currentPlaylistTracks=tracks; state.currentGenre=q;
    rd.innerHTML='<div class="section-header"><h2 class="section-title">Sonuçlar</h2><span class="section-see-all">'+tracks.length+' şarkı</span></div><div class="track-list"><div class="track-list-header"><span>#</span><span>Başlık</span><span>Albüm</span><span>Süre</span></div>'+tracks.map((t,i)=>renderTrackListItem(t,i, 'search')).join('')+'</div>';
  },400);
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
  return `<div class="track-card ${ip?'playing':''}" onclick="playFromGrid('${gridId}',${index})" data-track-id="${track.id}"><div class="track-card-art"><img src="${track.artwork}" alt="${escapeHtml(track.name)}" loading="lazy" onerror="this.src='${getDefaultArtwork()}'"><button class="track-card-play" onclick="event.stopPropagation();playFromGrid('${gridId}',${index})">${ip?'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>':'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'}</button><button class="card-like-btn ${il?'liked':''}" onclick="event.stopPropagation();toggleLikeById('${trackIdStr}')"><svg viewBox="0 0 24 24" fill="${likeFill}" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></button><button class="card-shared-btn" onclick="event.stopPropagation();openAddToSharedMenu('${trackIdStr}')" title="Ortak listeye ekle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zM8 11c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg></button></div><div class="track-card-info"><div class="track-card-name">${escapeHtml(track.name)}</div><div class="track-card-artist">${escapeHtml(track.artist)}</div></div></div>`;
}
function renderTrackListItem(track,index, context = 'playlist') {
  const ip=state.currentTrack&&state.currentTrack.id===track.id;
  const il=state.likedSongs.some(s=>s.id===track.id);
  const d=formatTime(track.duration);
  const isPlayingIcon = ip&&state.isPlaying ? '<div class="equalizer"><div class="equalizer-bar"></div><div class="equalizer-bar"></div><div class="equalizer-bar"></div><div class="equalizer-bar"></div></div>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const likeFill = il ? 'currentColor' : 'none';
  const trackIdStr = String(track.id).replace(/'/g, "\\'");
  const artistEsc = escapeHtml(track.artist || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]/g, ' ');
  const nameEsc = escapeHtml(track.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]/g, ' ');
  return `<div class="track-list-item ${ip?'playing':''}" onclick="playFromContext('${context}', ${index})" data-track-id="${track.id}"><div><span class="track-list-number">${index+1}</span><span class="track-list-play-icon">${isPlayingIcon}</span></div><div class="track-list-info"><div class="track-list-art"><img src="${track.artworkSmall||track.artwork}" alt="" loading="lazy" onerror="this.src='${getDefaultArtwork()}'></div><div class="track-list-text"><div class="track-list-name">${escapeHtml(track.name)}</div><div class="track-list-artist">${escapeHtml(track.artist)}</div></div></div><div class="track-list-album">${escapeHtml(track.album||'')}</div><div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;"><button class="track-yt-btn" onclick="event.stopPropagation();openYouTube(${artistEsc}, ${nameEsc})" title="YouTube'da Ara"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></button><button class="track-like-btn ${il?'liked':''}" onclick="event.stopPropagation();toggleLikeById('${trackIdStr}')" title="Beğen"><svg width="16" height="16" viewBox="0 0 24 24" fill="${likeFill}" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 3?"/></svg></button><button class="track-shared-btn" onclick="event.stopPropagation();openAddToSharedMenu('${trackIdStr}')" title="Ortak listeye ekle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zM8 11c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg></button><span class="track-list-duration">${d}</span></div></div>`;
}
function playFromContext(context, idx) {
  if (context === 'search' || context === 'playlist') state.queue = [...state.currentPlaylistTracks];
  else if (context === 'liked') state.queue = [...state.likedSongs];
  else if (context === 'mySongs') state.queue = [...state.mySongs];
  state.queueIndex = idx; playTrack(state.queue[idx]);
}
function toggleLikeById(id) {
  const allTracks = [...state.currentPlaylistTracks, ...state.likedSongs, ...state.mySongs, ...state.recentlyPlayed];
  if (state.currentTrack) allTracks.push(state.currentTrack);
  const track = allTracks.find(t => String(t.id) === String(id));
  if (track) toggleLikeTrack(track);
}

// ── Ortak Çalma Listeleri ──
const SHARED_API = '/api/playlists';
state.mySharedPlaylists = [];
state.activeSharedPlaylist = null;

function currentUserName() {
  const account = getAccount();
  return account?.name || 'Misafir';
}

async function sharedApiCall(action, { method = 'GET', body, query } = {}) {
  const params = new URLSearchParams({ action, ...(query || {}) });
  const url = method === 'GET' ? `${SHARED_API}?${params.toString()}` : `${SHARED_API}?action=${action}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `İstek başarısız (${res.status})`);
  return data;
}

function openSharedPlaylists() {
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(el=>el.classList.toggle('active', el.dataset.view === 'sharedPlaylists'));
  document.getElementById('sharedPlaylistsModal').hidden = false;
  document.getElementById('sharedListView').hidden = false;
  document.getElementById('sharedDetailView').hidden = true;
  document.getElementById('sharedListError').textContent = '';
  refreshMySharedPlaylists();
}
function closeSharedPlaylists() {
  document.getElementById('sharedPlaylistsModal').hidden = true;
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(el=>el.classList.toggle('active', el.dataset.view === state.currentView));
}

function showSharedError(message) {
  const el = document.getElementById('sharedListError');
  if (el) el.textContent = message;
  showToast(message);
}

async function refreshMySharedPlaylists() {
  const user = currentUserName();
  const container = document.getElementById('mySharedPlaylists');
  try {
    const { playlists } = await sharedApiCall('list', { query: { userName: user } });
    state.mySharedPlaylists = playlists || [];
    renderMySharedPlaylists();
  } catch (err) {
    console.error('Shared playlists list error:', err);
    container.innerHTML = '<p class="shared-empty-hint">Listeler yüklenemedi. Bağlantını kontrol et.</p>';
  }
}

function renderMySharedPlaylists() {
  const container = document.getElementById('mySharedPlaylists');
  const badge = document.getElementById('sharedPlaylistsBadge');
  if (!state.mySharedPlaylists.length) {
    container.innerHTML = '<p class="shared-empty-hint">Henüz ortak listen yok. Yeni bir tane oluştur ya da arkadaşının kodunu gir.</p>';
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent = String(state.mySharedPlaylists.length);
  container.innerHTML = state.mySharedPlaylists.map((p) => `
    <button class="shared-playlist-row" onclick="openSharedPlaylistDetail('${p.code}')">
      <div class="shared-playlist-row-icon">🎶</div>
      <div class="shared-playlist-row-info">
        <div class="shared-playlist-row-name">${escapeHtml(p.name)}</div>
        <div class="shared-playlist-row-meta">${p.members.length} üye · ${p.tracks.length} şarkı</div>
      </div>
      <div class="shared-playlist-row-code">${p.code}</div>
    </button>
  `).join('');
}

function promptCreateSharedPlaylist() {
  const name = prompt('Ortak çalma listesine bir isim ver:', 'Bizim Liste');
  if (name === null) return;
  createSharedPlaylist(name.trim() || 'Bizim Liste');
}

async function createSharedPlaylist(name) {
  const user = currentUserName();
  try {
    const { playlist } = await sharedApiCall('create', {
      method: 'POST',
      body: { name, ownerName: user, tracks: [] },
    });
    showToast(`"${playlist.name}" oluşturuldu. Kod: ${playlist.code}`);
    await refreshMySharedPlaylists();
    openSharedPlaylistDetail(playlist.code);
  } catch (err) {
    showSharedError(err.message || 'Liste oluşturulamadı.');
  }
}

async function joinSharedPlaylistByCode() {
  const input = document.getElementById('joinCodeInput');
  const code = input.value.trim().toUpperCase();
  if (!code) { showSharedError('Bir kod gir.'); return; }
  const user = currentUserName();
  try {
    const { playlist } = await sharedApiCall('join', { method: 'POST', body: { code, userName: user } });
    input.value = '';
    showToast(`"${playlist.name}" listesine katıldın.`);
    await refreshMySharedPlaylists();
    openSharedPlaylistDetail(playlist.code);
  } catch (err) {
    showSharedError(err.message || 'Katılım başarısız. Kodu kontrol et.');
  }
}

async function openSharedPlaylistDetail(code) {
  try {
    const { playlist } = await sharedApiCall('get', { query: { code } });
    state.activeSharedPlaylist = playlist;
    document.getElementById('sharedListView').hidden = true;
    document.getElementById('sharedDetailView').hidden = false;
    renderSharedPlaylistDetail();
  } catch (err) {
    showSharedError(err.message || 'Liste açılamadı.');
  }
}

function closeSharedPlaylistDetail() {
  state.activeSharedPlaylist = null;
  document.getElementById('sharedListView').hidden = false;
  document.getElementById('sharedDetailView').hidden = true;
  refreshMySharedPlaylists();
}

function renderSharedPlaylistDetail() {
  const p = state.activeSharedPlaylist;
  if (!p) return;
  const user = currentUserName();
  document.getElementById('sharedDetailName').textContent = p.name;
  document.getElementById('sharedDetailMembers').textContent = `${p.members.length} üye`;
  document.getElementById('sharedDetailTrackCount').textContent = `${p.tracks.length} şarkı`;
  document.getElementById('sharedDetailCode').textContent = p.code;

  const tracksEl = document.getElementById('sharedDetailTracks');
  if (!p.tracks.length) {
    tracksEl.innerHTML = '<p class="shared-empty-hint">Bu listede henüz şarkı yok. Bir şarkının yanındaki "Ortak listeye ekle" butonunu kullan.</p>';
    return;
  }
  const likes = p.likes || {};
  tracksEl.innerHTML = p.tracks.map((track, i) => {
    const likedByNames = Object.keys(likes).filter((name) => likes[name]);
    const trackLikedByMe = false; // per-track beğeni sonraki adımda genişletilebilir
    return `
    <div class="shared-track-row" data-track-id="${track.id}">
      <span class="shared-track-index">${i + 1}</span>
      <img class="shared-track-art" src="${track.artworkSmall || track.artwork}" alt="" loading="lazy" onerror="this.src='${getDefaultArtwork()}'">
      <div class="shared-track-info" onclick="playSharedTrack(${i})">
        <div class="shared-track-name">${escapeHtml(track.name)}</div>
        <div class="shared-track-artist">${escapeHtml(track.artist)}</div>
      </div>
      <button class="shared-track-remove" onclick="removeSharedTrack('${track.id}')" title="Listeden çıkar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
  }).join('') + renderPlaylistLikesFooter(p, user);
}

function renderPlaylistLikesFooter(p, user) {
  const likes = p.likes || {};
  const likedNames = Object.keys(likes).filter((n) => likes[n]);
  const iLiked = likedNames.includes(user);
  return `
    <div class="shared-playlist-footer">
      <button class="shared-like-playlist-btn ${iLiked ? 'liked' : ''}" onclick="toggleSharedPlaylistLike()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="${iLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        ${iLiked ? 'Beğenildi' : 'Beğen'}
      </button>
      <span class="shared-like-names">${likedNames.length ? `Beğenenler: ${likedNames.map(escapeHtml).join(', ')}` : 'Henüz kimse beğenmedi'}</span>
    </div>`;
}

async function toggleSharedPlaylistLike() {
  const p = state.activeSharedPlaylist;
  if (!p) return;
  const user = currentUserName();
  const alreadyLiked = Boolean((p.likes || {})[user]);
  try {
    const { playlist } = await sharedApiCall('like', {
      method: 'POST',
      body: { code: p.code, userName: user, liked: !alreadyLiked },
    });
    state.activeSharedPlaylist = playlist;
    renderSharedPlaylistDetail();
  } catch (err) {
    showToast(err.message || 'Beğeni gönderilemedi.');
  }
}

function playSharedTrack(index) {
  const p = state.activeSharedPlaylist;
  if (!p || !p.tracks[index]) return;
  state.queue = p.tracks.map(sharedTrackToPlayable);
  state.queueIndex = index;
  playTrack(state.queue[index]);
}

function playSharedPlaylistAll() {
  const p = state.activeSharedPlaylist;
  if (!p || !p.tracks.length) return;
  state.queue = p.tracks.map(sharedTrackToPlayable);
  state.queueIndex = 0;
  playTrack(state.queue[0]);
}

function sharedTrackToPlayable(t) {
  return { ...t };
}

async function addTrackToSharedPlaylist(code, track) {
  const user = currentUserName();
  try {
    const { playlist } = await sharedApiCall('addTrack', {
      method: 'POST',
      body: { code, userName: user, track: {
        id: track.id, name: track.name, artist: track.artist, album: track.album,
        artwork: track.artwork, artworkSmall: track.artworkSmall,
        previewUrl: track.previewUrl, duration: track.duration, isFullSong: track.isFullSong,
      } },
    });
    showToast(`"${track.name}" ${playlist.name} listesine eklendi.`);
    if (state.activeSharedPlaylist && state.activeSharedPlaylist.code === code) {
      state.activeSharedPlaylist = playlist;
      renderSharedPlaylistDetail();
    }
  } catch (err) {
    showToast(err.message || 'Şarkı eklenemedi.');
  }
}

async function removeSharedTrack(trackId) {
  const p = state.activeSharedPlaylist;
  if (!p) return;
  try {
    const { playlist } = await sharedApiCall('removeTrack', {
      method: 'POST',
      body: { code: p.code, trackId },
    });
    state.activeSharedPlaylist = playlist;
    renderSharedPlaylistDetail();
  } catch (err) {
    showToast(err.message || 'Şarkı kaldırılamadı.');
  }
}

function copySharedCode() {
  const p = state.activeSharedPlaylist;
  if (!p) return;
  navigator.clipboard?.writeText(p.code).then(() => showToast('Kod kopyalandı: ' + p.code))
    .catch(() => showToast('Kod: ' + p.code));
}

function openAddToSharedMenu(trackJsonId) {
  const allTracks = [...state.currentPlaylistTracks, ...state.likedSongs, ...state.mySongs, ...state.recentlyPlayed];
  if (state.currentTrack) allTracks.push(state.currentTrack);
  const track = allTracks.find(t => String(t.id) === String(trackJsonId));
  if (!track) { showToast('Şarkı bulunamadı.'); return; }

  if (!state.mySharedPlaylists.length) {
    if (confirm('Henüz ortak listen yok. Yeni bir tane oluşturmak ister misin?')) {
      const name = prompt('Ortak çalma listesine bir isim ver:', 'Bizim Liste');
      if (name === null) return;
      createSharedPlaylistThenAdd(name.trim() || 'Bizim Liste', track);
    }
    return;
  }
  const options = state.mySharedPlaylists.map((p, i) => `${i + 1}. ${p.name} (${p.code})`).join('\n');
  const choice = prompt(`Hangi listeye eklensin?\n${options}\n\n(Numara yaz, ya da yeni liste için 0 yaz)`, '1');
  if (choice === null) return;
  const idx = parseInt(choice, 10);
  if (idx === 0) {
    const name = prompt('Ortak çalma listesine bir isim ver:', 'Bizim Liste');
    if (name === null) return;
    createSharedPlaylistThenAdd(name.trim() || 'Bizim Liste', track);
    return;
  }
  const target = state.mySharedPlaylists[idx - 1];
  if (!target) { showToast('Geçersiz seçim.'); return; }
  addTrackToSharedPlaylist(target.code, track);
}

async function createSharedPlaylistThenAdd(name, track) {
  const user = currentUserName();
  try {
    const { playlist } = await sharedApiCall('create', {
      method: 'POST',
      body: { name, ownerName: user, tracks: [] },
    });
    await refreshMySharedPlaylists();
    await addTrackToSharedPlaylist(playlist.code, track);
  } catch (err) {
    showToast(err.message || 'Liste oluşturulamadı.');
  }
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
  if('mediaSession'in navigator) {
    navigator.mediaSession.metadata=new MediaMetadata({title:t.name,artist:t.artist,album:t.album||'',artwork:[{src:t.artworkSmall||t.artwork,sizes:'150x150',type:'image/jpeg'},{src:t.artwork,sizes:'480x480',type:'image/jpeg'}]});
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play',()=>togglePlayPause());
    navigator.mediaSession.setActionHandler('pause',()=>togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack',()=>playPrev());
    navigator.mediaSession.setActionHandler('nexttrack',()=>playNext());
    navigator.mediaSession.setActionHandler('seekbackward',(details)=>{
      const skip = details.seekOffset || 10;
      if (state.playbackMode === 'youtube' && ytPlayer) ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime()-skip), true);
      else audio.currentTime = Math.max(0, audio.currentTime - skip);
    });
    navigator.mediaSession.setActionHandler('seekforward',(details)=>{
      const skip = details.seekOffset || 10;
      if (state.playbackMode === 'youtube' && ytPlayer) ytPlayer.seekTo(ytPlayer.getCurrentTime()+skip, true);
      else audio.currentTime = Math.min(audio.duration||Infinity, audio.currentTime + skip);
    });
    try {
      navigator.mediaSession.setActionHandler('seekto',(details)=>{
        if (details.seekTime == null) return;
        if (state.playbackMode === 'youtube' && ytPlayer) ytPlayer.seekTo(details.seekTime, true);
        else audio.currentTime = details.seekTime;
      });
    } catch (e) { /* seekto not supported everywhere */ }
    updateMediaSessionPosition();
  }
}

function updateMediaSessionPosition() {
  if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
  try {
    let duration = 0, position = 0;
    if (state.playbackMode === 'youtube' && ytPlayerReady && ytPlayer) {
      duration = ytPlayer.getDuration() || 0;
      position = ytPlayer.getCurrentTime() || 0;
    } else {
      duration = audio.duration || 0;
      position = audio.currentTime || 0;
    }
    if (!duration || !isFinite(duration)) return;
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: state.nightcoreOn ? 1.15 : 1,
      position: Math.min(position, duration),
    });
  } catch (e) { /* ignore transient state mismatches */ }
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

// ── Volume ──
let isDraggingVolume=false;
function startVolumeDrag(e) { isDraggingVolume=true; updateVolumeFromEvent(e); document.addEventListener('mousemove',handleVolumeDrag); document.addEventListener('mouseup',stopVolumeDrag); }
function handleVolumeDrag(e) { if(isDraggingVolume) updateVolumeFromEvent(e); }
function stopVolumeDrag() { isDraggingVolume=false; document.removeEventListener('mousemove',handleVolumeDrag); document.removeEventListener('mouseup',stopVolumeDrag); }

let isDraggingBoost=false;
function updateBoostFromEvent(e) {
  const wrapper = document.getElementById('boostSliderWrapper');
  const rect = wrapper.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const percent = Math.round(50 + ratio * 100);
  setBoostGain(percent);
}
function startBoostDrag(e) { isDraggingBoost=true; updateBoostFromEvent(e); document.addEventListener('mousemove',handleBoostDrag); document.addEventListener('mouseup',stopBoostDrag); }
function handleBoostDrag(e) { if(isDraggingBoost) updateBoostFromEvent(e); }
function stopBoostDrag() { isDraggingBoost=false; document.removeEventListener('mousemove',handleBoostDrag); document.removeEventListener('mouseup',stopBoostDrag); }
function updateVolumeIcon() { document.getElementById('iconVolumeHigh').style.display=state.isMuted?'none':'block'; document.getElementById('iconVolumeMuted').style.display=state.isMuted?'block':'none'; }

// ── Progress Bar ──
function startSeek(e) {
  state.isSeeking=true; const duration=audio.duration||0;
  const onMove=(e)=>{ if(!state.isSeeking) return; const bar=document.getElementById('progressBar'),rect=bar.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)); document.getElementById('progressFill').style.width=`${ratio*100}%`; document.getElementById('currentTime').textContent=formatTime(ratio*duration); };
  const onUp=(e)=>{ state.isSeeking=false; seekTo(e); document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); };
  document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
}
audio.addEventListener('canplay',()=>{ state.audioReady=true; });
audio.addEventListener('ended',()=>{ if(Date.now()-state.trackStartTime>1000){ state.errorCount=0; playNext(); } else { state.errorCount++; if(state.errorCount<state.maxErrors) setTimeout(()=>playNext(),1000); else { showToast('Bazı şarkılar yüklenemiyor.'); state.isPlaying=false; updatePlayerUI(); state.errorCount=0; } } });
audio.addEventListener('error', (e) => {
  console.error('Audio error:', e);
  state.errorCount++;
  if (state.errorCount < state.maxErrors) {
    showToast('Şarkı yüklenemedi, sonraki deneniyor...');
    setTimeout(() => playNext(), 1500);
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
  document.querySelectorAll(`[data-track-id="${trackId}"] .track-like-btn, [data-track-id="${trackId}"] .card-like-btn`).forEach(btn => {
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
function showToast(msg) { const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._timeout); t._timeout=setTimeout(()=>t.classList.remove('show'),2500); }
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
  if (volume) volume.value = String(Math.round(state.volume * 100));
  if (value) value.textContent = `${Math.round(state.volume * 100)}%`;
  if (muteButton) {
    muteButton.textContent = state.isMuted ? 'Açık' : 'Kapalı';
    muteButton.setAttribute('aria-pressed', String(state.isMuted));
  }
}
function setSettingsVolume(value) {
  state.volume = Math.max(0, Math.min(1, Number(value) / 100));
  state.isMuted = false;
  audio.volume = state.volume;
  if (ytPlayerReady && ytPlayer) ytPlayer.setVolume(state.volume * 100);
  const fill = document.getElementById('volumeFill');
  if (fill) fill.style.width = `${state.volume * 100}%`;
  updateVolumeIcon();
  syncSettingsUI();
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
function handleFileSelect(input,labelId) { document.getElementById(labelId).textContent=input.files&&input.files[0]?input.files[0].name:'Seçilmedi'; }
function getAudioDuration(file) { return new Promise((resolve)=>{const u=URL.createObjectURL(file),ta=new Audio(u);ta.addEventListener('loadedmetadata',()=>{resolve(Math.round(ta.duration));URL.revokeObjectURL(u);});}); }
function fileToBlob(file) { return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=e=>resolve(new Blob([e.target.result],{type:file.type}));r.onerror=e=>reject(e);r.readAsArrayBuffer(file);}); }
async function handleSongUpload(e) {
  e.preventDefault(); const title=document.getElementById('songTitle').value.trim(),artist=document.getElementById('songArtist').value.trim(),af=document.getElementById('songAudioFile').files[0],cf=document.getElementById('songCoverFile').files[0];
  if(!af){showToast('Lütfen bir ses dosyası seçin!');return;} showToast('Şarkı işleniyor...');
  try {
    const ab=await fileToBlob(af); let art=getDefaultArtwork();
    if(cf){ const cb=await fileToBlob(cf); art=await new Promise((resolve)=>{const r=new FileReader();r.onloadend=()=>resolve(r.result);r.readAsDataURL(cb);}); }
    const dur=await getAudioDuration(af); await saveSongToDB({name:title,artist:artist,album:'Yerel Yükleme',artwork:art,artworkSmall:art,audioBlob:ab,duration:dur});
    showToast('Şarkı eklendi! 🎉'); document.getElementById('uploadForm').reset(); document.getElementById('audioFileName').textContent='Seçilmedi'; document.getElementById('coverFileName').textContent='Seçilmedi';
    await loadMySongsFromDB(); renderMySongs();
  } catch(err){console.error('Upload error:',err);showToast('Şarkı yüklenirken hata oluştu.');}
}
async function loadMySongsFromDB() { try { const songs=await getSongsFromDB(); state.mySongs=songs.map(s=>{const u=URL.createObjectURL(s.audioBlob);return{id:'local_'+s.id,dbId:s.id,name:s.name,artist:s.artist,album:s.album,artwork:s.artwork,artworkSmall:s.artworkSmall,previewUrl:u,duration:s.duration};}); } catch(err){console.error('Load custom songs error:',err);} }

function renderMySongs() {
  const c=document.getElementById('mySongsList'); const ce=document.getElementById('mySongsCount'); ce.textContent=state.mySongs.length+' şarkı';
  if(state.mySongs.length===0){ c.innerHTML='<div class="empty-state" style="padding:40px 0;"><div class="empty-state-icon">📤</div><h3 class="empty-state-title">Henüz şarkı yüklemedin</h3><p class="empty-state-text">Yukarıdaki formu kullanarak ilk MP3 şarkını yükle!</p></div>'; return; }
  const html=state.mySongs.map((track,i)=>{
    const ip=state.currentTrack&&state.currentTrack.id===track.id;
    const il=state.likedSongs.some(s=>s.id===track.id);
    const d=formatTime(track.duration);
    const isPlayingIcon=ip&&state.isPlaying?'<div class="equalizer"><div class="equalizer-bar"></div><div class="equalizer-bar"></div><div class="equalizer-bar"></div><div class="equalizer-bar"></div></div>':'<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    const likeFill=il?'currentColor':'none';
    const trackIdStr = String(track.id).replace(/'/g, "\\'");
    return `<div class="track-list-item ${ip?'playing':''}" onclick="playFromContext('mySongs', ${i})" data-track-id="${track.id}"><div><span class="track-list-number">${i+1}</span><span class="track-list-play-icon">${isPlayingIcon}</span></div><div class="track-list-info"><div class="track-list-art"><img src="${track.artwork}" alt="" loading="lazy"></div><div class="track-list-text"><div class="track-list-name">${escapeHtml(track.name)}</div><div class="track-list-artist">${escapeHtml(track.artist)}</div></div></div><div class="track-list-album">${escapeHtml(track.album||'')}</div><div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;"><button class="track-like-btn ${il?'liked':''}" onclick="event.stopPropagation();toggleLikeById('${trackIdStr}')" title="Beğen"><svg width="16" height="16" viewBox="0 0 24 24" fill="${likeFill}" stroke="currentColor" stroke-width="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></button><button class="track-shared-btn" onclick="event.stopPropagation();openAddToSharedMenu('${trackIdStr}')" title="Ortak listeye ekle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zM8 11c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg></button><button class="track-delete-btn" onclick="event.stopPropagation();removeCustomSong(${track.dbId})" title="Sil"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button><span class="track-list-duration">${d}</span></div></div>`;
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
  createHeroParticles();
  initTheme();
  audio.playbackRate = state.nightcoreOn ? 1.15 : 1;
  updateAudioModeUI();
  try { state.lyricOffsets = JSON.parse(localStorage.getItem('spoflix_lyric_offsets') || '{}'); } catch (error) { state.lyricOffsets = {}; }
  updateAccountUI();
  await getAudiusHost();
  try { await initDatabase(); await loadMySongsFromDB(); } catch(e) { console.error('DB init failed:',e); }
  document.getElementById('trendingGrid').innerHTML=renderSkeletonCards(8);
  document.getElementById('newReleasesGrid').innerHTML=renderSkeletonCards(8);
  document.getElementById('recommendedGrid').innerHTML=renderSkeletonCards(8);
  try { const t=await getTrendingTracks('week',20); window._gridData_trendingGrid=t; const tg=document.getElementById('trendingGrid'); if(t.length>0) tg.innerHTML=t.map((t,i)=>renderTrackCard(t,i,'trendingGrid')).join(''); else tg.innerHTML='<p style="color:var(--text-secondary);padding:20px;">Yükleniyor...</p>'; } catch(e){console.error('Trending error:',e);}
  try { const nr=await getTrendingTracks('month',20); window._gridData_newReleasesGrid=nr; const ng=document.getElementById('newReleasesGrid'); if(nr.length>0) ng.innerHTML=nr.map((t,i)=>renderTrackCard(t,i,'newReleasesGrid')).join(''); } catch(e){console.error('New releases error:',e);}
  try { const rec=await getTrendingTracks('year',20); window._gridData_recommendedGrid=rec; const rg=document.getElementById('recommendedGrid'); if(rec.length>0) rg.innerHTML=rec.map((t,i)=>renderTrackCard(t,i,'recommendedGrid')).join(''); } catch(e){console.error('Recommended error:',e);}
  updateLikedCountDisplay();
}
document.addEventListener('keydown',(e)=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  switch(e.code) {
    case 'Space': e.preventDefault(); togglePlayPause(); break;
    case 'ArrowRight': if(e.shiftKey) playNext(); else audio.currentTime=Math.min(audio.currentTime+5,audio.duration); break;
    case 'ArrowLeft': if(e.shiftKey) playPrev(); else audio.currentTime=Math.max(audio.currentTime-5,0); break;
    case 'ArrowUp': e.preventDefault(); state.volume=Math.min(1,state.volume+0.05); audio.volume=state.volume; document.getElementById('volumeFill').style.width=`${state.volume*100}%`; break;
    case 'ArrowDown': e.preventDefault(); state.volume=Math.max(0,state.volume-0.05); audio.volume=state.volume; document.getElementById('volumeFill').style.width=`${state.volume*100}%`; break;
    case 'KeyM': toggleMute(); break;
    case 'KeyS': if(e.ctrlKey){ e.preventDefault(); navigateTo('search'); } break;
  }
});
document.addEventListener('DOMContentLoaded', initApp);
// ── 1. YOUTUBE FALLBACK PLAYER SİSTEMİ ──
let ytPlayer = null;
let ytPlayerReady = false;
let ytTimeInterval = null;

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
      },
      'onStateChange': onYtPlayerStateChange,
      'onError': () => playNext()
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
  if (event.data === YT.PlayerState.PLAYING) {
    state.audioReady = true;
    state.isPlaying = true;
    if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(state.nightcoreOn ? 1.25 : 1);
    document.getElementById('totalTime').textContent = formatTime(ytPlayer.getDuration());
    
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
function playTrack(track) {
  if(!track) {
    state.errorCount++;
    if(state.errorCount < state.maxErrors) setTimeout(() => playNext(), 500);
    return;
  }

  // Her çağrıya benzersiz bir "token" ver. audio.play() gibi asenkron
  // işlemler tamamlandığında token hala en güncel mi diye kontrol edilecek.
  // Böylece araya başka bir şarkı seçimi girdiyse (kullanıcı hızlı tıkladıysa),
  // eski/bayat isteğin sonucu yeni şarkının üzerine yazamaz.
  const myToken = ++state.playToken;

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
  
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audio.currentTime = 0;
  if(ytPlayerReady && ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
  clearInterval(ytTimeInterval);

  const shouldPlay = true;
  state.isPlaying = false; // Yeni şarkı yüklenirken duraklat
  
  if (track.previewUrl) {
    state.playbackMode = 'audio';
    audio.src = track.previewUrl;
    audio.load();
    audio.playbackRate = state.nightcoreOn ? 1.15 : 1;
    if (shouldPlay) {
      audio.play().then(() => {
        if (myToken !== state.playToken) return;
        state.isPlaying = true;
        startAudioMotion();
        updatePlayerUI();
        updatePlayingStates();
      }).catch(e => {
        if (myToken !== state.playToken) return;
        console.error('audio.play() failed:', e);
        state.isPlaying = false;
        updatePlayerUI();
      });
    }
  } else if (ytPlayerReady && ytPlayer) {
    state.playbackMode = 'youtube';
    document.getElementById("totalTime").textContent = "0:00";
    document.getElementById("currentTime").textContent = "0:00";
    document.getElementById("progressFill").style.width = "0%";
    
        if (track.youtubeId) ytPlayer.loadVideoById(track.youtubeId);
        else ytPlayer.loadPlaylist({ listType: 'search', list: track.artist + ' ' + track.name, index: 0 });
        ytPlayer.unMute();
        ytPlayer.setVolume(state.isMuted ? 0 : state.volume * 100);
    if (shouldPlay) ytPlayer.playVideo();
    if (!state.youtubeBgWarningShown) {
      state.youtubeBgWarningShown = true;
      showToast('Not: YouTube kaynaklı şarkılar arka planda durabilir (YouTube kısıtlaması).');
    }
  } else {
    state.playbackMode = 'audio';
    state.isPlaying = false;
    showToast('Bu şarkı için oynatılabilir kaynak bulunamadı.');
    updatePlayerUI();
    setTimeout(() => { if (myToken === state.playToken) playNext(); }, 1000);
  }
    state.isPlaying = state.playbackMode === 'youtube' ? shouldPlay : false;
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
    if(state.playbackMode === 'youtube' && ytPlayer) ytPlayer.playVideo();
    else audio.play().catch(e => console.error(e)); 
    state.isPlaying = true; 
    startAudioMotion();
  }
  updatePlayerUI(); 
  updatePlayingStates();
}

function seekTo(e) {
  if(!state.currentTrack) return;
  const bar = document.getElementById('progressBar');
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  
  if(state.playbackMode === 'youtube' && ytPlayer) {
      ytPlayer.seekTo(ratio * ytPlayer.getDuration(), true);
  } else {
      audio.currentTime = ratio * (audio.duration || 0);
  }
}

// ── 3. SES VE İLERLEME ÇUBUĞU (PROGRESS BAR) GÜNCELLEMELERİ ──
function updateVolumeFromEvent(e) {
  const bar = document.getElementById('volumeBar');
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  
  state.volume = ratio; 
  state.isMuted = false; 
  audio.volume = Math.min(1, ratio);
  
  if(ytPlayerReady && ytPlayer) ytPlayer.setVolume(ratio * 100);
  
  document.getElementById('volumeFill').style.width = `${ratio * 100}%`; 
  updateVolumeIcon();
}

function toggleMute() {
  state.isMuted = !state.isMuted;
  if(state.isMuted) { 
      audio.volume = 0; 
      if(ytPlayerReady && ytPlayer) ytPlayer.setVolume(0); 
  } else { 
      audio.volume = Math.min(1, state.volume); 
      if(ytPlayerReady && ytPlayer) ytPlayer.setVolume(state.volume * 100); 
  }
  document.getElementById('volumeFill').style.width = state.isMuted ? '0%' : `${state.volume * 100}%`; 
  updateVolumeIcon();
}

audio.addEventListener('timeupdate', () => { 
  if(state.isSeeking || state.playbackMode === 'youtube') return; 
  const c = audio.currentTime;
  const d = audio.duration || 0; 
  if(d > 0){ 
    document.getElementById('progressFill').style.width = `${(c / d) * 100}%`; 
    document.getElementById('currentTime').textContent = formatTime(c); 
    document.getElementById('totalTime').textContent = formatTime(d); 
  }
  syncLyrics(c);
  updateMediaSessionPosition();
});

// ── Arka planda çalmaya devam etme ──
// Sekme arka plana atıldığında bazı tarayıcılar AudioContext'i otomatik
// suspend eder (özellikle nightcore/boost aktifken kullanılan Web Audio
// graph'ı). Bu, sekme öne alınana kadar sessiz kalmaya sebep olur ve
// bazı Android WebView'lerde audio elementini de durdurabilir. Aşağıdaki
// handler sekme her görünür olduğunda context'i canlandırıp oynatmayı
// senkronize ediyor; ayrıca arka plana geçişte context'i suspend ETMEMEK
// için hiçbir şey yapmıyoruz (varsayılan davranış zaten devam ettirmek).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    // Bazı mobil tarayıcılar sekme arka plandayken audio elementini
    // "paused" durumuna sokabiliyor ama state.isPlaying hâlâ true kalıyor.
    // Öne dönüldüğünde gerçek durumu senkronize ediyoruz.
    if (state.isPlaying && state.playbackMode === 'audio' && audio.paused) {
      audio.play().catch(() => {});
    }
    updateMediaSessionPosition();
  }
  // visibilityState === 'hidden' durumunda bilinçli olarak audio.pause()
  // veya audioContext.suspend() ÇAĞIRMIYORUZ — arka planda çalmaya devam
  // etmesinin sebabı bu.
});

// iOS Safari ve bazı Android tarayıcılarında AudioContext, kullanıcı
// etkileşimi olmadan "interrupted" durumuna geçebiliyor (örn. gelen
// arama, başka bir uygulamanın ses çalması). pagehide/pageshow ile de
// aynı kurtarmayı yapıyoruz çünkü bazı tarayıcılar visibilitychange
// yerine bunu tetikliyor.
window.addEventListener('pageshow', () => {
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  if (state.isPlaying && state.playbackMode === 'audio' && audio.paused) {
    audio.play().catch(() => {});
  }
});