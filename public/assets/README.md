# Warframe Market Tool

<div align="center">

◆

**Tracker de prix pour [warframe.market](https://warframe.market)**

[🇫🇷 Français](#-français) · [🇬🇧 English](#-english)

</div>

---

## 🇫🇷 Français

### Présentation

**Warframe Market Tool** est une application desktop construite avec **Electron** qui permet de suivre et analyser les prix des items sur [warframe.market](https://warframe.market).

Elle calcule un **score de liquidité** pour chaque item afin d'identifier les meilleures opportunités de trading : les items les plus vendus au meilleur prix.

### Fonctionnalités

- Consultation des prix par catégorie : **Arcane**, **Mod**, **Warframe**, **Weapon**
- Calcul du score de liquidité (prix moyen pondéré × volume)
- Cache journalier pour éviter les requêtes répétées
- Export des données en **CSV**
- Interface dark sci-fi inspirée de l'univers Warframe

### Installation

> Pré-requis : [Node.js](https://nodejs.org) 18 ou supérieur

```bash
# Cloner le projet
git clone https://github.com/ton-compte/warframe-market-tool.git
cd warframe-market-tool

# Installer les dépendances
npm install

# Lancer en développement
npm start
```

### Générer un exécutable

```bash
# Windows (.exe)
npm run build:win

# macOS (.dmg)
npm run build:mac

# Linux (.AppImage)
npm run build:linux
```

Le fichier installateur se trouve dans le dossier `dist/` après le build.

> **Note Windows** : si le build échoue avec une erreur de lien symbolique, relance le terminal en **Administrateur** ou active le **Mode développeur** dans les paramètres Windows.

### Structure du projet

```
warframe-market-tool/
├── main.js                    ← Point d'entrée Electron + serveur Express
├── preload.js                 ← Pont sécurisé Electron
├── package.json
└── public/
    ├── index.html             ← Interface utilisateur
    ├── WarframeMarketTool.js  ← Logique métier
    └── assets/
        └── warframe_market_icon.ico
```

### Comment ça marche

1. L'app lance un serveur **Express** en interne sur le port `3000`
2. Ce serveur proxy les appels vers l'API publique de `warframe.market`
3. Les résultats sont mis en **cache journalier** via `localStorage`
4. Le score de liquidité est calculé avec la formule :

```
liquidityScore = prixMoyenPondéré × log10(quantitéTotale + 1)
```

### Utilisation

| Bouton | Action |
|---|---|
| Arcane / Mod / Warframe / Weapon | Charge et affiche les 20 meilleurs items de la catégorie |
| Initialiser toutes les données | Pré-charge les 4 catégories en cache |
| Exporter en CSV | Sauvegarde les données en fichiers `.csv` |
| Effacer le cache | Vide le cache local pour forcer un rechargement |

### Licence

MIT — libre d'utilisation et de modification.

---

## 🇬🇧 English

### Overview

**Warframe Market Tool** is a desktop application built with **Electron** that tracks and analyzes item prices on [warframe.market](https://warframe.market).

It computes a **liquidity score** for each item to help identify the best trading opportunities — items that sell fast at a good price.

### Features

- Price browsing by category: **Arcane**, **Mod**, **Warframe**, **Weapon**
- Liquidity score calculation (weighted average price × volume)
- Daily cache to avoid redundant API calls
- **CSV** export
- Dark sci-fi UI inspired by the Warframe universe

### Installation

> Requires: [Node.js](https://nodejs.org) 18 or higher

```bash
# Clone the repository
git clone https://github.com/your-account/warframe-market-tool.git
cd warframe-market-tool

# Install dependencies
npm install

# Run in development mode
npm start
```

### Build an executable

```bash
# Windows (.exe)
npm run build:win

# macOS (.dmg)
npm run build:mac

# Linux (.AppImage)
npm run build:linux
```

The installer will be found in the `dist/` folder after the build.

> **Windows note**: if the build fails with a symlink error, run your terminal as **Administrator** or enable **Developer Mode** in Windows Settings.

### Project structure

```
warframe-market-tool/
├── main.js                    ← Electron entry point + embedded Express server
├── preload.js                 ← Electron secure bridge
├── package.json
└── public/
    ├── index.html             ← User interface
    ├── WarframeMarketTool.js  ← Business logic
    └── assets/
        └── warframe_market_icon.ico
```

### How it works

1. The app starts an embedded **Express** server on port `3000`
2. This server proxies calls to the public `warframe.market` API
3. Results are **cached daily** using `localStorage`
4. The liquidity score is computed as:

```
liquidityScore = weightedAvgPrice × log10(totalQuantity + 1)
```

### Usage

| Button | Action |
|---|---|
| Arcane / Mod / Warframe / Weapon | Load and display the top 20 items in the category |
| Initialize all data | Pre-loads all 4 categories into cache |
| Export to CSV | Saves data as `.csv` files |
| Clear cache | Wipes local cache to force a fresh fetch |

### License

MIT — free to use and modify.

---

<div align="center">

◆

*This tool is a fan-made project and is not affiliated with Digital Extremes or warframe.market.*

</div>
