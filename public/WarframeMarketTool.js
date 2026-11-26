// ============================================
// Utils
// ============================================
async function apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function round(value, decimals = 2) {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

function isSameDay(dateA, dateB) {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

// ============================================
// Local Storage pour cache des données (fallback)
// ============================================
function getCachedData(mode) {
  const cached = localStorage.getItem(`market_${mode}`);
  if (!cached) return null;
  
  const parsed = JSON.parse(cached);
  const cachedDate = new Date(parsed.timestamp);
  const today = new Date();
  
  if (isSameDay(cachedDate, today)) {
    return parsed.data;
  }
  
  return null;
}

function setCachedData(mode, data) {
  const payload = {
    timestamp: new Date().toISOString(),
    data: data
  };
  localStorage.setItem(`market_${mode}`, JSON.stringify(payload));
}

// ============================================
// CSV Generation
// ============================================
function generateCSV(data, mode) {
  const headers = ["Item", "Prix moyen", "Ratio", "Date"];
  const date = new Date().toISOString().split('T')[0];
  
  let csv = headers.join(",") + "\n";
  
  for (const row of data) {
    const itemName = row.item_name || row.item;
    const price = row.weightedAvgPrice;
    const ratio = row.ratio || row.liquidityScore;
    csv += `"${itemName}",${price},${ratio},${date}\n`;
  }
  
  return csv;
}

function downloadCSV(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ============================================
// File System Access API (navigateurs modernes)
// ============================================
let csvDirectoryHandle = null;

async function selectOrCreateCSVDirectory() {
  try {
    csvDirectoryHandle = await window.showDirectoryPicker();
    try {
      csvDirectoryHandle = await csvDirectoryHandle.getDirectoryHandle('csv', { create: true });
    } catch (e) {
      console.log("Utilisation du dossier sélectionné directement");
    }
    return true;
  } catch (e) {
    console.error("Erreur lors de la sélection du dossier:", e);
    return false;
  }
}

async function saveCSVToDirectory(csvContent, filename) {
  if (!csvDirectoryHandle) {
    const selected = await selectOrCreateCSVDirectory();
    if (!selected) {
      throw new Error("Aucun dossier sélectionné");
    }
  }
  
  try {
    const fileHandle = await csvDirectoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(csvContent);
    await writable.close();
    return true;
  } catch (e) {
    console.error("Erreur lors de l'écriture du fichier:", e);
    return false;
  }
}

// ============================================
// Config par mode
// ============================================
const Config = {
  arcane: {
    filterItems: item => item.tags.includes("arcane_enhancement"),
    filterOrders: order =>
      order.type === "sell" &&
      order.rank === 5 &&
      order.platinum > 1 &&
      order.platinum < 3000
  },
  mod: {
    filterItems: item =>
      item.tags.includes("legendary") &&
      item.tags.includes("mod") &&
      !item.tags.includes("pvp"),
    filterOrders: order =>
      order.type === "sell" &&
      order.platinum > 1 &&
      order.platinum < 999
  },
  warframe: {
    filterItems: item =>
      item.tags.includes("prime") &&
      item.tags.includes("set") &&
      item.tags.includes("warframe"),
    filterOrders: order =>
      order.type === "sell" &&
      order.platinum > 1 &&
      order.platinum < 999
  },
  weapon: {
    filterItems: item =>
      item.tags.includes("prime") &&
      item.tags.includes("set") &&
      item.tags.includes("weapon"),
    filterOrders: order =>
      order.type === "sell" &&
      order.platinum > 1 &&
      order.platinum < 999
  }
};

// ============================================
// Core logic
// ============================================
async function runMarketTool(mode) {
  window._setStatus("Chargement des items…", "loading");
  const { filterItems, filterOrders } = Config[mode];

  try {
    const itemsResponse = await apiGet("/api/items");
    const items = Object.values(itemsResponse.data).filter(filterItems);

    const table = [];
    const batchSize = 5;

    for (let batchStart = 0; batchStart < items.length; batchStart += batchSize) {
      const batch = items.slice(batchStart, batchStart + batchSize);

      await Promise.all(batch.map(async (item, idx) => {
        const pos = batchStart + idx + 1;
        window._setStatus(`(${pos}/${items.length}) ${item.slug}`, "loading");
        try {
          const orders = (await apiGet(`/api/orders/${item.slug}`)).data;
          const filteredOrders = orders.filter(filterOrders);
          if (filteredOrders.length > 0) {
            table.push({ item: item.slug, orders: filteredOrders });
            if (window.dbAPI?.saveHistoricalPrices) {
              await window.dbAPI.saveHistoricalPrices(item.slug, filteredOrders.slice(0, 50)).catch(() => {});
            }
          }
        } catch (err) {
          console.warn(`Erreur ${item.slug}:`, err.message);
        }
      }));

      if (batchStart + batchSize < items.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    return computeLiquidityScore(table);
  } catch (error) {
    console.error('Erreur runMarketTool:', error);
    throw error;
  }
}

// ============================================
// Liquidity score
// ============================================
function computeLiquidityScore(table) {
  return table
    .map(({ item, orders }) => {
      const totalQty = orders.reduce((s, o) => s + (o.quantity || 1), 0);
      const weightedSum = orders.reduce((s, o) => s + o.platinum * (o.quantity || 1), 0);
      const weightedAvgPrice = totalQty > 0 ? Math.floor(weightedSum / totalQty) : 0;
      const liquidityScore = weightedAvgPrice > 0
        ? Math.floor(weightedAvgPrice * Math.log10(totalQty + 1))
        : 0;
      return { item, totalQty, orders: orders.length, weightedAvgPrice, liquidityScore };
    })
    .sort((a, b) => b.liquidityScore - a.liquidityScore)
    .slice(0, 20);
}

// ============================================
// Get Market Data (avec cache et BDD)
// ============================================
async function getMarketData(mode) {
  // Essayer d'abord la BDD
  try {
    const dbData = await window.dbAPI.getMarketData(mode);
    if (dbData && dbData.length > 0) {
      return dbData.map(d => ({
        item_name: d.item_slug,
        weightedAvgPrice: d.weighted_avg_price,
        ratio: d.liquidity_score,
        totalQty: d.total_quantity,
        orders: d.orders_count
      }));
    }
  } catch (error) {
    console.warn('Erreur BDD, utilisation du cache local:', error);
  }

  // Fallback au cache local
  const cached = getCachedData(mode);
  if (cached) {
    return cached;
  }

  // Récupérer depuis l'API
  try {
    const apiData = await runMarketTool(mode);
    const formattedData = apiData.map(i => ({
      item_name: i.item,
      weightedAvgPrice: i.weightedAvgPrice,
      ratio: i.liquidityScore,
      totalQty: i.totalQty,
      orders: i.orders
    }));

    // Sauvegarder dans la BDD
    try {
      await window.dbAPI.saveMarketData(mode, apiData);
    } catch (error) {
      console.error('Erreur sauvegarde BDD:', error);
    }

    // Et dans le cache local
    setCachedData(mode, formattedData);

    return formattedData;
  } catch (error) {
    console.error('Erreur récupération API:', error);
    throw error;
  }
}

// ============================================
// UI
// ============================================
function renderTable(data, mode) {
  window._renderTableStyled(data, mode);
}

// ============================================
// Button bindings
// ============================================
["arcane", "mod", "warframe", "weapon"].forEach(mode => {
  const btn = document.getElementById(mode.charAt(0).toUpperCase() + mode.slice(1));
  btn.onclick = async () => {
    window._setStatus("Chargement…");
    try {
      const data = await getMarketData(mode);
      renderTable(data, mode);
      window._setStatus("Terminé ✔");
    } catch (error) {
      console.error(error);
      window._setStatus("Erreur lors du chargement", "error");
    }
  };
});

document.getElementById("ExportCSV").onclick = async () => {
  window._setStatus("Sélectionnez un dossier pour sauvegarder...");
  
  const modes = ["arcane", "mod", "warframe", "weapon"];
  let successCount = 0;
  
  try {
    for (const mode of modes) {
      const data = await getMarketData(mode);
      if (data) {
        const csv = generateCSV(data, mode);
        const date = new Date().toISOString().split('T')[0];
        const filename = `warframe_${mode}_${date}.csv`;
        
        const saved = await saveCSVToDirectory(csv, filename);
        if (saved) successCount++;
      }
    }
    
    window._setStatus(`${successCount} fichiers CSV sauvegardés ✔`);
  } catch (error) {
    console.error(error);
    window._setStatus("Erreur lors de l'export - Utilisation du téléchargement classique...");
    
    for (const mode of modes) {
      const data = await getMarketData(mode);
      if (data) {
        const csv = generateCSV(data, mode);
        const date = new Date().toISOString().split('T')[0];
        downloadCSV(csv, `warframe_${mode}_${date}.csv`);
      }
    }
    window._setStatus("Export CSV (téléchargement) terminé ✔");
  }
};

document.getElementById("InitDB").onclick = async () => {
  window._setStatus("Initialisation des données…", "loading");

  try {
    const modes = ["arcane", "mod", "warframe", "weapon"];
    
    for (const mode of modes) {
      const data = await runMarketTool(mode);
      const formattedData = data.map(i => ({
        item_name: i.item,
        weightedAvgPrice: i.weightedAvgPrice,
        ratio: i.liquidityScore,
        totalQty: i.totalQty,
        orders: i.orders
      }));
      setCachedData(mode, formattedData);
      await window.dbAPI.saveMarketData(mode, data);
    }

    window._setStatus("Données initialisées ✔");
  } catch (error) {
    console.error(error);
    window._setStatus("Erreur lors de l'initialisation", "error");
  }
};

document.getElementById("ClearCache").onclick = async () => {
  const modes = ["arcane", "mod", "warframe", "weapon"];
  modes.forEach(m => localStorage.removeItem(`market_${m}`));
  if (window.dbAPI?.clearTodayData) {
    await Promise.all(modes.map(m => window.dbAPI.clearTodayData(m).catch(() => {})));
  }
  window._setStatus("Cache effacé ✔");
};

document.getElementById("time").onclick = async () => {
  console.log(new Date().toISOString());
};
