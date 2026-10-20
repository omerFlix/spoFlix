const { contextBridge, ipcRenderer } = require('electron');

const AUDIO_MODES = new Set(['normal', 'boost', 'bass', 'nightcore']);

contextBridge.exposeInMainWorld('spoflixAudio', {
  setVolumeBoost(settings = {}) {
    const requestedMultiplier = Number(settings.multiplier);
    const multiplier = Number.isFinite(requestedMultiplier)
      ? Math.max(0, Math.min(2.5, requestedMultiplier))
      : 1;
    const mode = AUDIO_MODES.has(settings.mode) ? settings.mode : 'normal';

    ipcRenderer.send('set-volume-boost', { multiplier, mode });
  }
});
