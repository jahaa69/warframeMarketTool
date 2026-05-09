import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "url";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Serveur Express embarqué
// ============================================
const server = express();
const PORT = 3000;

server.use(cors());
server.use(express.static(path.join(__dirname, "public")));

server.get("/api/items", async (req, res) => {
  try {
    const response = await fetch("https://api.warframe.market/v2/items");
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

server.get("/api/orders/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const response = await fetch(
      `https://api.warframe.market/v2/orders/item/${slug}`
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
