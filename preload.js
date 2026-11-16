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
