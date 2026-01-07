import fs from "fs";
import fetch from "node-fetch"; // si Node <18, sinon fetch natif

// Paramètre mode (arcane, mod, warframe, weapon)
const mode = process.argv[2];
if (!["arcane", "mod", "warframe", "weapon"].includes(mode)) {
  console.error("Usage: node script.js <arcane|mod|warframe|weapon>");
  process.exit(1);
}

// ============================================
// Authentification
// ============================================
const tokenPath = "./jwt.token";
let authToken;
if (fs.existsSync(tokenPath)) {
  authToken = fs.readFileSync(tokenPath, "utf8").trim();
} else {
  console.error("JWT token file not found!");
  process.exit(1);
}

const headers = {
  "Authorization": authToken,
  "Platform": "pc",
  "Accept": "application/json"
};

// ============================================
// Utils
// ============================================
async function apiGet(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function round(value, decimals = 2) {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

// ============================================
// Config par mode
// ============================================
const Config = {
  arcane: {
    filterItems: item => item.tags.includes("arcane_enhancement"),
    filterOrders: order => order.type === "sell" && order.rank === 5 && order.platinum > 1 && order.platinum < 3000
  },
  mod: {
    filterItems: item => item.tags.includes("legendary") && item.tags.includes("mod") && !item.tags.includes("pvp"),
    filterOrders: order => order.type === "sell" && order.platinum > 1 && order.platinum < 999
  },
  warframe: {
    filterItems: item => item.tags.includes("prime") && item.tags.includes("set") && item.tags.includes("warframe"),
    filterOrders: order => order.type === "sell" && order.platinum > 1 && order.platinum < 999
  },
  weapon: {
    filterItems: item => item.tags.includes("prime") && item.tags.includes("set") && item.tags.includes("weapon"),
    filterOrders: order => order.type === "sell" && order.platinum > 1 && order.platinum < 999
  }
};

const itemFilter = Config[mode].filterItems;
const orderFilter = Config[mode].filterOrders;

// ============================================
// Load items
// ============================================
console.log("Loading items list...");
const itemsResponse = await apiGet("https://api.warframe.market/v2/items");
const items = Object.values(itemsResponse.data).filter(itemFilter);
console.log(`Found ${items.length} items for mode '${mode}'`);

// ============================================
// Get Market Orders
// ============================================
async function getMarketOrders(slugs) {
  const table = [];
  let i = 0;

  for (const slug of slugs) {
    i++;
    process.stdout.write(`\r[${i}/${slugs.length}] ${slug}`);

    let orders;
    try {
      orders = (await apiGet(`https://api.warframe.market/v2/orders/item/${slug}`)).data;
    } catch (err) {
      continue;
    }

    for (const o of orders.filter(orderFilter)) {
      table.push({
        item: slug,
        price: o.platinum,
        quantity: o.quantity,
        rank: o.rank
      });
    }

    await new Promise(r => setTimeout(r, 400)); // Respect API rate limit
  }
  console.log("\nDone fetching orders.");
  return table;
}

const slugs = items.map(i => i.slug);
const table = await getMarketOrders(slugs);

// ============================================
// Liquidity score calculation
// ============================================
function computeLiquidityScore(table) {
  const grouped = {};

  for (const row of table) {
    if (!grouped[row.item]) grouped[row.item] = [];
    grouped[row.item].push(row);
  }

  const result = Object.entries(grouped).map(([item, orders]) => {
    const totalQty = orders.reduce((s, o) => s + o.quantity, 0);
    const weightedSum = orders.reduce((s, o) => s + o.price * o.quantity, 0);
    const weightedAvgPrice = totalQty ? round(weightedSum / totalQty, 2) : 0;
    const liquidityScore = totalQty ? round(weightedAvgPrice * Math.log10(totalQty + 1), 2) : 0;

    return {
      item,
      totalQty,
      orders: orders.length,
      weightedAvgPrice,
      liquidityScore
    };
  });

  return result
    .sort((a, b) => b.liquidityScore - a.liquidityScore)
    .slice(0, 20);
}

const topItems = computeLiquidityScore(table);

// ============================================
// Display
// ============================================
console.table(topItems);
