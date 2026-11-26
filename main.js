const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const { saveMarketData, saveHistoricalPrices, getHistoricalPrices, getMarketData, clearTodayData } = require('./database.js');
const { registerRivenIpc, barometer } = require('./rivenBackend.js');

let mainWindow = null;

// ============================================
// Serveur Express embarqué
// ============================================
const server = express();
const PORT = 3000;

server.use(cors());
server.use(express.static(path.join(__dirname, "public")));

const WF_HEADERS = {
  "User-Agent": "WarframeMarketTool/1.0",
  "Accept": "application/json",
  "Platform": "pc",
  "Language": "en",
};

server.get("/api/items", async (req, res) => {
  try {
    const response = await fetch("https://api.warframe.market/v2/items", { headers: WF_HEADERS });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Warframe Market API returned ${response.status}: ${body}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error fetching items:', err);
    res.status(500).json({ error: err.message });
  }
});

server.get("/api/orders/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const response = await fetch(
      `https://api.warframe.market/v2/orders/item/${slug}`,
      { headers: WF_HEADERS }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Warframe Market API returned ${response.status}: ${body}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(`Error fetching orders for ${slug}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Statistiques warframe.market sur 90 jours (ventes conclues) + verdict "bon moment pour vendre ?"
// Objets à rangs (mods, arcanes) : seul le rang max est gardé (comme le tableau des arcanes, rang 5).
const statsCache = new Map(); // slug -> { at, body } (6 h)
server.get("/api/statistics/:slug", async (req, res) => {
  const { slug } = req.params;
  const hit = statsCache.get(slug);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return res.json(hit.body);
  try {
    const response = await fetch(
      `https://api.warframe.market/v1/items/${encodeURIComponent(slug)}/statistics`,
      { headers: WF_HEADERS }
    );
    if (!response.ok) throw new Error(`Warframe Market API returned ${response.status}`);
    const rows = ((await response.json()).payload.statistics_closed || {})["90days"] || [];
    const ranks = rows.map(r => r.mod_rank).filter(r => r != null);
    const rank = ranks.length ? Math.max(...ranks) : null;
    const body = { rank, ...barometer(rank == null ? rows : rows.filter(r => r.mod_rank === rank), { basis: "price" }) };
    statsCache.set(slug, { at: Date.now(), body });
    res.json(body);
  } catch (err) {
    console.error(`Error fetching statistics for ${slug}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () =>
  console.log(`Express server running at http://localhost:${PORT}`)
);

// ============================================
// Fenêtre Electron
// ============================================
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, "public", "assets", "warframe_market_icon.ico"),
    title: "Warframe Market Tool",
    backgroundColor: "#121212",
  });
  mainWindow = win;
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });

  // Charger l'app depuis le serveur Express local
  win.loadURL(`http://localhost:${PORT}`);

  // Ouvrir les DevTools en développement (commenter en prod)
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  // Handlers IPC pour la base de données
  ipcMain.handle('save-market-data', async (event, mode, data) => {
    await saveMarketData(mode, data);
  });

  ipcMain.handle('save-historical-prices', async (event, itemSlug, orders) => {
    await saveHistoricalPrices(itemSlug, orders);
  });

  ipcMain.handle('get-historical-prices', async (event, itemSlug) => {
    return await getHistoricalPrices(itemSlug);
  });

  ipcMain.handle('get-market-data', async (event, mode) => {
    return await getMarketData(mode);
  });

  ipcMain.handle('clear-today-data', async (event, mode) => {
    await clearTodayData(mode);
  });

  // Page Rivens : handlers riven:*. Le .env / rivens.json sont lus depuis la racine du projet en dev,
  // et depuis userData une fois packagé (__dirname est alors dans app.asar, en lecture seule).
  registerRivenIpc({
    ipcMain,
    dialog,
    getWindow: () => mainWindow,
    dir: app.isPackaged ? app.getPath('userData') : __dirname,
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
