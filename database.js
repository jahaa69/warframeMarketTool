const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'warframe_market.db');
const db = new sqlite3.Database(dbPath);

// Créer les tables si elles n'existent pas
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS market_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_slug TEXT NOT NULL,
      mode TEXT NOT NULL,
      date TEXT NOT NULL,
      weighted_avg_price REAL,
      liquidity_score REAL,
      total_quantity INTEGER,
      orders_count INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS historical_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_slug TEXT NOT NULL,
      date TEXT NOT NULL,
      price REAL,
      quantity INTEGER,
      rank INTEGER
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_market_mode_date ON market_data(mode, date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_historical_slug ON historical_prices(item_slug)`);
});

function saveMarketData(mode, data, date = new Date().toISOString().split('T')[0]) {
  return new Promise((resolve, reject) => {
    if (data.length === 0) return resolve();
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM market_data WHERE mode = ? AND date = ?', [mode, date]);
      const stmt = db.prepare(`
        INSERT INTO market_data (item_slug, mode, date, weighted_avg_price, liquidity_score, total_quantity, orders_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of data) {
        stmt.run([item.item, mode, date, item.weightedAvgPrice, item.liquidityScore, item.totalQty, item.orders]);
      }
      stmt.finalize(err => {
        if (err) { db.run('ROLLBACK'); return reject(err); }
        db.run('COMMIT', err2 => err2 ? reject(err2) : resolve());
      });
    });
  });
}

function saveHistoricalPrices(itemSlug, orders, date = new Date().toISOString().split('T')[0]) {
  return new Promise((resolve, reject) => {
    if (orders.length === 0) return resolve();
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      const stmt = db.prepare(`
        INSERT INTO historical_prices (item_slug, date, price, quantity, rank)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const order of orders) {
        stmt.run([itemSlug, date, order.platinum, order.quantity, order.rank]);
      }
      stmt.finalize(err => {
        if (err) { db.run('ROLLBACK'); return reject(err); }
        db.run('COMMIT', err2 => err2 ? reject(err2) : resolve());
      });
    });
  });
}

function getHistoricalPrices(itemSlug) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT date, ROUND(AVG(price)) as price, SUM(quantity) as quantity
      FROM historical_prices
      WHERE item_slug = ?
      GROUP BY date
      ORDER BY date ASC
      LIMIT 30
    `, [itemSlug], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function clearTodayData(mode, date = new Date().toISOString().split('T')[0]) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM market_data WHERE mode = ? AND date = ?', [mode, date], err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function getMarketData(mode, date = new Date().toISOString().split('T')[0]) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT * FROM market_data
      WHERE mode = ? AND date = ?
      ORDER BY liquidity_score DESC
    `, [mode, date], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function closeDatabase() {
  db.close();
}

module.exports = {
  saveMarketData,
  saveHistoricalPrices,
  getHistoricalPrices,
  getMarketData,
  clearTodayData,
  closeDatabase
};