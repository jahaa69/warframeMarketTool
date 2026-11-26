#!/usr/bin/env python3
"""
riven_manager.py - lit rivens.json (produit par ocrRiven.py), calcule un prix de marché par riven,
garde un historique local des prix (pour tracer ta propre courbe), et permet de Vendre / Retirer
sur warframe.market en un clic.

Installation : pip install requests matplotlib
Token       : variable d'environnement WFM_JWT (cookie 'JWT' de warframe.market). Jamais dans le code.
Usage       : python riven_manager.py [rivens.json]

SÉCURITÉ : par défaut c'est une SIMULATION (rien n'est envoyé). Coche "Envoyer pour de vrai"
pour publier. Chaque vente/retrait demande une confirmation avec le détail exact.
"""
import csv, datetime, json, os, pathlib, statistics, sys, time

def load_env(path=None):
    here = pathlib.Path(__file__).resolve().parent
    candidates = [pathlib.Path(path)] if path else [here / ".env", here.parent / ".env"]
    for p in candidates:
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        return

load_env()

BASE = "https://api.warframe.market/v1"
HIST = pathlib.Path("price_history.csv")
POLARITIES = ["madurai", "vazarin", "naramon", "zenurik", "unairu", "penjaga"]   # À VÉRIFIER (annonce existante)
MULTIPLIER_STATS = {"damage_vs_grineer", "damage_vs_corpus", "damage_vs_infested"}  # affichés "x1.47" -> valeur 47

def headers():
    return {"Platform": "pc", "Language": "en", "Authorization": f"JWT {os.environ.get('WFM_JWT', '')}",
            "Content-Type": "application/json"}

def key_of(r):
    return f"{r['weapon_url_name']}|{','.join(sorted(r['pos']))}|{','.join(sorted(r['neg']))}"

# ---------- prix ----------
def market_price(r, session):
    """Annonces comparables (mêmes stats positives/négatives), vendeurs connectés, achat direct."""
    p = {"type": "riven", "weapon_url_name": r["weapon_url_name"],
         "positive_stats": ",".join(r["pos"][:3]), "sort_by": "price_asc", "buyout_policy": "direct"}
    p["negative_stats"] = ",".join(r["neg"][:1]) if r["neg"] else "none"
    resp = session.get(f"{BASE}/auctions/search", params=p, headers=headers(), timeout=15)
    resp.raise_for_status()
    prices = [a["buyout_price"] for a in resp.json()["payload"]["auctions"]
              if a["owner"]["status"] in ("ingame", "online") and a.get("buyout_price")]
    five = prices[:5]
    return {"n": len(prices), "min": min(prices) if prices else None,
            "median": int(statistics.median(five)) if five else None}

def log_price(r, info):
    new = not HIST.exists()
    with HIST.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new: w.writerow(["date", "key", "n", "min", "median"])
        w.writerow([datetime.datetime.now().isoformat(timespec="minutes"), key_of(r), info["n"], info["min"], info["median"]])

def plot_history(r):
    import matplotlib.pyplot as plt
    rows = [x for x in csv.DictReader(HIST.open(encoding="utf-8"))] if HIST.exists() else []
    rows = [x for x in rows if x["key"] == key_of(r) and x["median"] not in ("", "None")]
    if len(rows) < 2: return False
    d = [datetime.datetime.fromisoformat(x["date"]) for x in rows]
    plt.figure(figsize=(8, 4)); plt.title(f"{r['weapon']} – prix du marché (stats filtrées)")
    plt.plot(d, [float(x["median"]) for x in rows], "o-", label="médiane des 5 moins chers")
    plt.plot(d, [float(x["min"]) for x in rows], "--", label="minimum")
    plt.ylabel("platine"); plt.legend(); plt.gcf().autofmt_xdate(); plt.tight_layout(); plt.show()
    return True

# ---------- vente / retrait ----------
def attribute_payload(s):
    v = s["value"]
    if s["stat"] in MULTIPLIER_STATS: v = round((v - 1) * 100, 1)      # x1.47 -> 47.0 (À VÉRIFIER)
    return {"url_name": s["stat"], "positive": s["positive"], "value": v}

def sell_payload(r, price, polarity, note=""):
    return {"item": {"type": "riven", "weapon_url_name": r["weapon_url_name"], "name": r["riven_name"],
                     "mastery_level": r["mastery_level"], "re_rolls": r["re_rolls"], "mod_rank": r["mod_rank"],
                     "polarity": polarity, "attributes": [attribute_payload(s) for s in r["stats"]]},
            "note": note, "starting_price": price, "buyout_price": price,
            "minimal_reputation": 0, "minimal_increment": 1, "private": False}

def do_sell(r, price, polarity, session, live):
    body = sell_payload(r, price, polarity)
    if not live: return True, "SIMULATION – rien envoyé :\n" + json.dumps(body, indent=2, ensure_ascii=False)
    x = session.post(f"{BASE}/auctions/create", json=body, headers=headers(), timeout=15)
    try: r["auction_id"] = x.json()["payload"]["auction"]["id"]
    except Exception: pass
    return x.ok, f"HTTP {x.status_code}\n{x.text[:600]}"

def do_unsell(r, session, live):
    if not r.get("auction_id"): return False, "Pas d'auction_id connu pour ce riven (vends-le d'abord depuis cet outil)."
    if not live: return True, f"SIMULATION – fermerait l'annonce {r['auction_id']}"
    x = session.put(f"{BASE}/auctions/entry/{r['auction_id']}/close", headers=headers(), timeout=15)
    return x.ok, f"HTTP {x.status_code}\n{x.text[:600]}"

# ---------- interface ----------
def run_ui(path):
    import requests, tkinter as tk
    from tkinter import ttk, messagebox
    p = pathlib.Path(path); rivens = json.loads(p.read_text(encoding="utf-8"))
    for r in rivens: r.setdefault("price", None); r.setdefault("polarity", "")
    s = requests.Session()
    root = tk.Tk(); root.title("Rivens – warframe.market")
    tree = ttk.Treeview(root, columns=("arme", "stats", "n", "min", "med", "prix", "etat"), show="headings", height=16)
    for c, w in (("arme", 120), ("stats", 330), ("n", 40), ("min", 50), ("med", 60), ("prix", 60), ("etat", 90)):
        tree.heading(c, text=c); tree.column(c, width=w)
    tree.pack(fill="both", expand=True)
    live = tk.BooleanVar(value=False)
    pol = tk.StringVar(); price = tk.StringVar()

    def save(): p.write_text(json.dumps(rivens, indent=2, ensure_ascii=False), encoding="utf-8")
    def label(r): return " ".join(("+" if st["positive"] else "−") + st["stat"] for st in r["stats"])
    def refresh_row(i):
        r = rivens[i]; tree.item(i, values=(r["weapon"], label(r), r.get("n", ""), r.get("min", ""), r.get("median", ""),
                                            r.get("price") or "", "EN VENTE" if r.get("auction_id") else ""))
    def pick(_=None):
        sel = tree.selection()
        if sel: r = rivens[int(sel[0])]; price.set(r.get("price") or ""); pol.set(r.get("polarity", ""))

    def scan():
        for i in tree.get_children(): tree.delete(i)
        for i, r in enumerate(rivens): tree.insert("", "end", iid=i); refresh_row(i)
        for i, r in enumerate(rivens):
            try:
                info = market_price(r, s); log_price(r, info)
                r.update(n=info["n"], min=info["min"], median=info["median"])
                r["price"] = info["median"]; refresh_row(i); root.update(); time.sleep(0.4)
            except Exception as e:
                messagebox.showerror("Prix", f"{r['weapon']} : {e}"); break
        save()

    def cur():
        sel = tree.selection()
        return (int(sel[0]), rivens[int(sel[0])]) if sel else (None, None)

    def sell():
        i, r = cur()
        if r is None: return
        try: pr = int(price.get())
        except ValueError: return messagebox.showwarning("Prix", "Prix invalide.")
        if not pol.get(): return messagebox.showwarning("Polarité", "Choisis la polarité (non lue par l'OCR).")
        r["polarity"] = pol.get()
        if not messagebox.askyesno("Confirmer la vente", f"{r['weapon']} ({r['riven_name']})\n{label(r)}\n"
                                   f"Prix : {pr} pl   Polarité : {pol.get()}\n"
                                   f"Mode : {'RÉEL' if live.get() else 'simulation'}"): return
        ok, txt = do_sell(r, pr, pol.get(), s, live.get()); r["price"] = pr
        save(); refresh_row(i); messagebox.showinfo("OK" if ok else "Erreur", txt[:900])

    def unsell():
        i, r = cur()
        if r is None: return
        if not messagebox.askyesno("Retirer", f"Retirer {r['weapon']} de la vente ?\nMode : {'RÉEL' if live.get() else 'simulation'}"): return
        ok, txt = do_unsell(r, s, live.get())
        if ok and live.get(): r.pop("auction_id", None)
        save(); refresh_row(i); messagebox.showinfo("OK" if ok else "Erreur", txt[:900])

    def graph():
        i, r = cur()
        if r and not plot_history(r): messagebox.showinfo("Graphique", "Pas assez d'historique : lance « Calculer les prix » à plusieurs moments.")

    tree.bind("<<TreeviewSelect>>", pick)
    bar = tk.Frame(root); bar.pack(pady=4)
    tk.Button(bar, text="Calculer les prix", command=scan).pack(side="left", padx=3)
    tk.Label(bar, text="Prix").pack(side="left"); tk.Entry(bar, textvariable=price, width=7).pack(side="left")
    tk.Label(bar, text="Polarité").pack(side="left"); ttk.Combobox(bar, textvariable=pol, values=POLARITIES, width=9).pack(side="left")
    tk.Button(bar, text="Vendre", command=sell).pack(side="left", padx=3)
    tk.Button(bar, text="Retirer", command=unsell).pack(side="left", padx=3)
    tk.Button(bar, text="Graphique", command=graph).pack(side="left", padx=3)
    tk.Checkbutton(bar, text="Envoyer pour de vrai", variable=live).pack(side="left", padx=8)
    for i, r in enumerate(rivens): tree.insert("", "end", iid=i); refresh_row(i)
    root.mainloop()

if __name__ == "__main__":
    run_ui(sys.argv[1] if len(sys.argv) > 1 else "rivens.json")
