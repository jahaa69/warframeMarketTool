// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Exposer les APIs de base de données au renderer
contextBridge.exposeInMainWorld('dbAPI', {
  saveMarketData: (mode, data) => ipcRenderer.invoke('save-market-data', mode, data),
  saveHistoricalPrices: (itemSlug, orders) => ipcRenderer.invoke('save-historical-prices', itemSlug, orders),
  getHistoricalPrices: (itemSlug) => ipcRenderer.invoke('get-historical-prices', itemSlug),
  getMarketData: (mode) => ipcRenderer.invoke('get-market-data', mode),
  clearTodayData: (mode) => ipcRenderer.invoke('clear-today-data', mode),
});

// Page Rivens : expose uniquement ces fonctions (jamais le token, jamais fs ni child_process).
contextBridge.exposeInMainWorld('riven', {
  config:  ()            => ipcRenderer.invoke('riven:config'),
  load:    ()            => ipcRenderer.invoke('riven:load'),
  save:    rivens        => ipcRenderer.invoke('riven:save', rivens),
  price:   r             => ipcRenderer.invoke('riven:price', r),
  history: r             => ipcRenderer.invoke('riven:history', r),
  sell:    args          => ipcRenderer.invoke('riven:sell', args),
  unsell:  args          => ipcRenderer.invoke('riven:unsell', args),
  import:  args          => ipcRenderer.invoke('riven:import', args),
  barometer: r           => ipcRenderer.invoke('riven:barometer', r),
  daily:   ()            => ipcRenderer.invoke('riven:daily'),
  dailyStatus: ()        => ipcRenderer.invoke('riven:dailyStatus'),
});

// Page Paramètres : le token est en écriture seule (get() ne renvoie que "défini / non défini").
contextBridge.exposeInMainWorld('settings', {
  get:         ()        => ipcRenderer.invoke('settings:get'),
  set:         updates   => ipcRenderer.invoke('settings:set', updates),
  diagnostics: ()        => ipcRenderer.invoke('settings:diagnostics'),
});
