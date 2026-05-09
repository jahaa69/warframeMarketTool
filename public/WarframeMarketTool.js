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
// Local Storage pour cache des données
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

  const itemsResponse = await apiGet("http://localhost:3000/api/items");
  const items = Object.values(itemsResponse.data).filter(filterItems);

  const table = [];
  let i = 0;

  for (const item of items) {
    i++;
    window._setStatus(`(${i}/${items.length}) ${item.slug}`, "loading");

    let orders;
    try {
      orders = (await apiGet(`http://localhost:3000/api/orders/${item.slug}`)).data;
    } catch {
      continue;
    }

    for (const o of orders.filter(filterOrders)) {
      table.push({
        item: item.slug,
        price: o.platinum,
        quantity: o.quantity,
        rank: o.rank
      });
    }

    await new Promise(r => setTimeout(r, 400));
  }

  return computeLiquidityScore(table);
}

// ============================================
// Liquidity score
// ============================================
function computeLiquidityScore(table) {
  const grouped = {};

  for (const row of table) {
    if (!grouped[row.item]) grouped[row.item] = [];
    grouped[row.item].push(row);
  }

  return Object.entries(grouped)
    .map(([item, orders]) => {
      const totalQty = orders.reduce((s, o) => s + o.quantity, 0);
      const weightedSum = orders.reduce((s, o) => s + o.price * o.quantity, 0);
      const weightedAvgPrice = totalQty ? Math.floor(weightedSum / totalQty) : 0;
      const liquidityScore = totalQty
        ? Math.floor(weightedAvgPrice * Math.log10(totalQty + 1))
        : 0;
      return {
        item,
        totalQty,
        orders: orders.length,
        weightedAvgPrice,
        liquidityScore
      };
    })
    .sort((a, b) => b.liquidityScore - a.liquidityScore)
    .slice(0, 20);
}

// ============================================
// Get Market Data (avec cache)
// ============================================
async function getMarketData(mode) {
  const cached = getCachedData(mode);
  if (cached) {
    return cached;
  }

  const apiData = await runMarketTool(mode);
  
  const formattedData = apiData.map(i => ({
    item_name: i.item,
    weightedAvgPrice: i.weightedAvgPrice,
    ratio: i.liquidityScore
  }));
  
  setCachedData(mode, formattedData);
  
  return formattedData;
}

// ============================================
// UI
// ============================================
function renderTable(data, mode) {
  const result = document.getElementById("result");

  let html = `
    <table>
      <tr>
        <th>Item</th>
        <th>Prix moyen</th>
        <th>Ratio</th>
      </tr>
  `;

  for (const d of data) {
    html += `
      <tr>
        <td>${d.item_name || d.item}</td>
        <td>${d.weightedAvgPrice}</td>
        <td>${d.ratio}</td>
      </tr>
    `;
  }

  result.innerHTML = html + "</table>";
  window._setStatus("Terminé ✔");
}

// ============================================
// Button bindings
// ============================================
["arcane", "mod", "warframe", "weapon"].forEach(mode => {
  const btn = document.getElementById(mode.charAt(0).toUpperCase() + mode.slice(1));
  btn.onclick = async () => {
    window._setStatus("Chargement…");
    const data = await getMarketData(mode);
    renderTable(data, mode);
  };
});

document.getElementById("ExportCSV").onclick = async () => {
  window._setStatus("Sélectionnez un dossier pour sauvegarder...");
  
  const modes = ["arcane", "mod", "warframe", "weapon"];
  let successCount = 0;
  
  try {
    for (const mode of modes) {
      const data = getCachedData(mode);
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
      const data = getCachedData(mode);
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
        ratio: i.liquidityScore
      }));
      setCachedData(mode, formattedData);
    }

    window._setStatus("Données initialisées ✔");
  } catch (error) {
    console.error(error);
    window._setStatus("Erreur lors de l'initialisation", "error");
  }
};

document.getElementById("ClearCache").onclick = () => {
  localStorage.removeItem("market_arcane");
  localStorage.removeItem("market_mod");
  localStorage.removeItem("market_warframe");
  localStorage.removeItem("market_weapon");
  window._setStatus("Cache effacé ✔");
};

document.getElementById("time").onclick = async () => {
  console.log(new Date().toISOString());
};
