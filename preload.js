// preload.js
// Ce fichier s'exécute dans un contexte isolé entre Electron et le renderer.
// Pour l'instant ton app n'a pas besoin d'APIs natives spéciales,
// donc ce fichier est vide mais requis pour la sécurité contextIsolation.

// Si tu veux exposer des APIs Node.js au frontend plus tard :
// const { contextBridge, ipcRenderer } = require("electron");
// contextBridge.exposeInMainWorld("electronAPI", { ... });
