const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const { saveMarketData, saveHistoricalPrices, getHistoricalPrices, getMarketData, clearTodayData } = require('./database.js');

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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
