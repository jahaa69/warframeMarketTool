#!/usr/bin/env python3
"""
riven_ocr.py - lit l'onglet "Unveiled rivens" d'AlecaFrame par OCR (Tesseract), carte par carte,
et ajoute les rivens NON listés sur warframe.market dans rivens.json (sans doublons).

Installation (Windows) :
  1) Moteur Tesseract : https://github.com/UB-Mannheim/tesseract/wiki
  2) pip install pytesseract pillow numpy scipy mss

Usage :
  python riven_ocr.py --grab                 # capture l'écran, ne lit QUE la zone du milieu (cartes)
  python riven_ocr.py --image capture.png    # lit une capture enregistrée
  python riven_ocr.py --grab --debug         # affiche le texte OCR de chaque carte
  Options :
    --middle / --no-middle    zone du milieu (par défaut : oui avec --grab, non avec --image)
    --crop x1,y1,x2,y2        zone personnalisée en pixels (prioritaire sur --middle)
    --include-listed          garde aussi les rivens déjà "Listed"
    --tesseract "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"
    --out rivens.json
Astuce : dans AlecaFrame, mets le filtre "Listed on warframe.market" sur "No" pour n'afficher que les non-listés.
"""
import argparse, json, re, sys, pathlib, shutil, os

# Tesseract installé mais absent du PATH (cas fréquent sous Windows)
if not shutil.which("tesseract"):
    for _p in (r"C:\Program Files\Tesseract-OCR\tesseract.exe",
               r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"):
        if os.path.exists(_p):
            import pytesseract
            pytesseract.pytesseract.tesseract_cmd = _p
            break

# Nom affiché par AlecaFrame -> url_name warframe.market  (À VÉRIFIER avec le Finder du site)
STAT_MAP = {
    "critical chance": "critical_chance", "critical damage": "critical_damage",
    "multishot": "multishot", "status chance": "status_chance", "status duration": "status_duration",
    "damage": "base_damage_/_melee_damage", "base damage": "base_damage_/_melee_damage",
    "melee damage": "base_damage_/_melee_damage",
    "fire rate": "fire_rate_/_attack_speed", "attack speed": "fire_rate_/_attack_speed",
    "reload speed": "reload_speed", "magazine capacity": "magazine_capacity",
    "ammo maximum": "ammo_maximum", "projectile speed": "projectile_speed", "range": "range",
    "punch through": "punch_through", "zoom": "zoom", "recoil": "recoil", "weapon recoil": "recoil",
    "finisher damage": "finisher_damage", "combo duration": "combo_duration",
    "initial combo": "initial_combo", "critical chance on slide attack": "critical_chance_on_slide_attack",
    "slide attack critical chance": "critical_chance_on_slide_attack",
    "chance to gain extra combo count": "chance_to_gain_extra_combo_count",
    "extra combo count chance": "chance_to_gain_extra_combo_count",
    "heat": "heat_damage", "cold": "cold_damage", "electricity": "electric_damage",
    "toxin": "toxin_damage", "impact": "impact_damage", "puncture": "puncture_damage", "slash": "slash_damage",
    "heat damage": "heat_damage", "cold damage": "cold_damage", "electricity damage": "electric_damage",
    "toxin damage": "toxin_damage", "impact damage": "impact_damage",
    "puncture damage": "puncture_damage", "slash damage": "slash_damage",
    "damage to grineer": "damage_vs_grineer", "damage to corpus": "damage_vs_corpus",
    "damage to infested": "damage_vs_infested",
    "damage vs grineer": "damage_vs_grineer", "damage vs corpus": "damage_vs_corpus",
    "damage vs infested": "damage_vs_infested",
}
INVERTED = {"recoil"}            # pour ces stats, une valeur négative est un BONUS
KEYS = sorted(STAT_MAP, key=len, reverse=True)

STAT_LINE = re.compile(r"^\s*([+\-−–xX×])?\s*(\d+(?:[.,]\d+)?)\s*(%|s)?\s*(.+?)\s*$")
CARD_BG = (16, 22, 35)           # fond des cartes (thème sombre par défaut d'AlecaFrame)
MIDDLE = (0.125, 0.19, 0.78, 0.95)   # fractions x1,y1,x2,y2 de l'écran : zone des cartes

def match_stat(label):
    n = re.sub(r"\(.*?\)", " ", label.lower())          # retire "(x2 for Bows)"
    n = re.sub(r"[^a-z ]+", " ", n); n = re.sub(r"\s+", " ", n).strip()
    return next((k for k in KEYS if k in n), None)

WEAPONS = []   # rempli depuis le cache d'AlecaFrame pour corriger les noms mal lus

def load_weapons(path=None):
    import os
    path = path or os.path.join(os.environ.get("LOCALAPPDATA", ""), "AlecaFrame", "cachedData", "custom", "rivensV2.json")
    try:
        d = json.load(open(path, encoding="utf-8-sig"))
        WEAPONS[:] = sorted({v["name"] for v in d["weaponStats"].values() if v.get("name")})
    except Exception:
        pass

def clean_weapon(raw):
    """Retire le bruit d'icône avant le nom, puis corrige par proximité avec la liste des armes."""
    toks = re.sub(r"[^A-Za-z' ]+", " ", raw).split()
    cands = [" ".join(toks[i:]) for i in range(len(toks))] or [raw]
    if WEAPONS:
        import difflib
        low = {w.lower(): w for w in WEAPONS}
        best = max(((difflib.SequenceMatcher(None, c.lower(), k).ratio(), low[k])
                    for c in cands for k in low), key=lambda t: t[0])
        if best[0] >= 0.6: return best[1]
    while toks and not re.match(r"^[A-Z][A-Za-z']{2,}$", toks[0]): toks.pop(0)
    return " ".join(toks) or raw

def find_grade(line):
    """Reconnaît Good/Potential/Poor même mal lu par l'OCR (ex. 'Sood')."""
    if STAT_LINE.match(line): return None
    import difflib
    for w in re.findall(r"[A-Za-z]{3,}", line):
        m = difflib.get_close_matches(w.lower(), ["good", "potential", "poor"], n=1, cutoff=0.7)
        if m: return m[0]
    return None

def parse_card(text, footer=None, weapon=None):
    """Texte OCR d'UNE carte -> dict riven (ou None). footer = (re_rolls) lu à part si dispo."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    gi = next((i for i, l in enumerate(lines) if i >= 2 and (find_grade(l) or re.search(r"\bListed\b", l))), None)
    if gi is None or gi < 2: return None
    head = [l for l in lines[:gi] if len(re.findall(r"[A-Za-z]", l)) >= 3]   # ignore les lignes-bruit d'icône
    if len(head) < 2: return None
    rv = {"weapon": clean_weapon(weapon if weapon and len(weapon) > 2 else head[-2]), "riven_name": (re.search(r"[A-Z][a-z]+-[a-z]+", head[-1]) or [head[-1]])[0], "stats": [], "listed": False, "grade": None,
          "mastery_level": None, "re_rolls": None, "mod_rank": None}
    for l in lines[gi:]:
        low = l.lower()
        if re.search(r"\blisted\b", low): rv["listed"] = True
        g = find_grade(l)
        if g: rv["grade"] = g; continue
        mr = re.search(r"\bMR\s*(\d+)", l)
        if mr:
            rv["mastery_level"] = int(mr.group(1))
            rk = re.search(r"Rank\s*([0-9OoQ]+)\s*/\s*8", l)
            if rk: rv["mod_rank"] = 8 if rk.group(1) == "8" else 0
            continue
        m = STAT_LINE.match(l)
        if not m: continue
        sign, num, unit, label = m.groups()
        key = match_stat(label)
        if not key: continue
        val = float(num.replace(",", "."))
        stat = STAT_MAP[key]
        if sign and sign.lower() in ("x", "×"):                 # multiplicateur (ex. x1.47 / x0.97)
            positive = val > 1; shown = val
        else:
            neg = sign in ("-", "−", "–")
            positive = (not neg) if stat not in INVERTED else neg
            shown = -val if neg else val
        if len(rv["stats"]) < 4:
            rv["stats"].append({"stat": stat, "value": shown, "positive": positive})
    if footer is not None: rv["re_rolls"] = footer
    if len(rv["stats"]) < 2: return None
    rv["weapon_url_name"] = re.sub(r"[^a-z0-9]+", "_", rv["weapon"].lower()).strip("_")
    rv["pos"] = [s["stat"] for s in rv["stats"] if s["positive"]]
    rv["neg"] = [s["stat"] for s in rv["stats"] if not s["positive"]]
    return rv

def find_cards(img, bg=CARD_BG):
    """Détecte les rectangles de cartes (fond sombre uniforme). Renvoie [(x1,y1,x2,y2)] triés ligne par ligne."""
    import numpy as np
    from scipy import ndimage as ndi
    a = np.asarray(img.convert("RGB")).astype(int)
    mask = np.abs(a - np.array(bg)).sum(2) <= 10
    mask = ndi.binary_closing(mask, structure=np.ones((9, 9)))
    lab, _ = ndi.label(mask)
    boxes = []
    for sl in ndi.find_objects(lab):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if 150 < w < 400 and 150 < h < 400:
            boxes.append((sl[1].start, sl[0].start, sl[1].stop, sl[0].stop))
    boxes.sort(key=lambda b: (round(b[1] / 100), b[0]))
    return boxes

def read_rerolls(card, tess=None):
    """Lit seulement le petit nombre à droite de l'icône de re-rolls (chiffres uniquement)."""
    import pytesseract
    from PIL import ImageOps
    if tess: pytesseract.pytesseract.tesseract_cmd = tess
    w, h = card.size
    g = ImageOps.grayscale(card.crop((int(.355 * w), int(.86 * h), int(.47 * w), int(.95 * h))))
    g = ImageOps.invert(ImageOps.autocontrast(g.resize((g.width * 5, g.height * 5))))
    t = pytesseract.image_to_string(g, config="--psm 7 -c tessedit_char_whitelist=0123456789").strip()
    return int(t) if t.isdigit() else None

def read_weapon(card, tess=None):
    """Lit le titre de l'arme seul (zone à droite de l'icône) : plus propre que l'OCR de toute la carte."""
    import pytesseract
    from PIL import ImageOps
    if tess: pytesseract.pytesseract.tesseract_cmd = tess
    w, h = card.size
    g = ImageOps.grayscale(card.crop((int(.31 * w), int(.05 * h), int(.97 * w), int(.155 * h))))
    g = ImageOps.invert(ImageOps.autocontrast(g.resize((g.width * 4, g.height * 4))))
    return pytesseract.image_to_string(g, config="--psm 7").strip()

def ocr(img, tess=None):
    import pytesseract
    from PIL import ImageOps
    if tess: pytesseract.pytesseract.tesseract_cmd = tess
    g = ImageOps.grayscale(img)
    g = g.resize((g.width * 3, g.height * 3))
    g = ImageOps.invert(ImageOps.autocontrast(g))        # texte sombre sur fond clair : meilleur pour Tesseract
    return pytesseract.image_to_string(g, config="--psm 6")

def pick_monitor(s, title="AlecaFrame", focus=True):
    """Écran à capturer : celui qui contient la fenêtre AlecaFrame (remise au premier plan), sinon l'écran principal.
    Avec plusieurs écrans, mss.monitors[1] n'est PAS forcément l'écran principal (il suit l'ordre de Windows)."""
    mons = s.monitors[1:]
    try:
        import ctypes, time
        user32 = ctypes.windll.user32
        found = []
        Enum = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        def cb(h, _):
            if user32.IsWindowVisible(h):
                n = user32.GetWindowTextLengthW(h)
                if n:
                    b = ctypes.create_unicode_buffer(n + 1); user32.GetWindowTextW(h, b, n + 1)
                    if title.lower() in b.value.lower(): found.append(h)
            return True
        user32.EnumWindows(Enum(cb), 0)
        class RECT(ctypes.Structure):
            _fields_ = [(k, ctypes.c_long) for k in ("l", "t", "r", "b")]
        best = None
        for h in found:
            rc = RECT(); user32.GetWindowRect(h, ctypes.byref(rc))
            area = (rc.r - rc.l) * (rc.b - rc.t)
            if best is None or area > best[0]: best = (area, h)
        if best:
            h = best[1]
            if focus:
                if user32.IsIconic(h): user32.ShowWindow(h, 9)
                user32.SetForegroundWindow(h); time.sleep(0.8)
            rc = RECT(); user32.GetWindowRect(h, ctypes.byref(rc))
            cx, cy = (rc.l + rc.r) // 2, (rc.t + rc.b) // 2
            for m in mons:
                if m["left"] <= cx < m["left"] + m["width"] and m["top"] <= cy < m["top"] + m["height"]:
                    return m, "écran de la fenêtre AlecaFrame"
    except Exception:
        pass
    prim = next((m for m in mons if m.get("is_primary")), None)
    return (prim, "écran principal (fenêtre AlecaFrame non trouvée)") if prim else (mons[0], "écran 1 (fenêtre AlecaFrame non trouvée)")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grab", action="store_true"); ap.add_argument("--image")
    ap.add_argument("--debug", action="store_true"); ap.add_argument("--out", default="rivens.json")
    ap.add_argument("--tesseract"); ap.add_argument("--crop")
    ap.add_argument("--middle", action=argparse.BooleanOptionalAction, default=None)
    ap.add_argument("--include-listed", action="store_true")
    ap.add_argument("--prune", action="store_true",
                    help="retire de --out les rivens qui ne sont plus visibles dans AlecaFrame (sauvegarde .bak)")
    ap.add_argument("--weapons", help="chemin de rivensV2.json (par défaut : cache AlecaFrame)")
    a = ap.parse_args()
    from PIL import Image
    if a.grab:
        import mss
        with getattr(mss, "MSS", mss.mss)() as s:
            mon, why = pick_monitor(s)
            print(f"Capture : {why} ({mon['width']}x{mon['height']} en {mon['left']},{mon['top']})")
            shot = s.grab(mon); img = Image.frombytes("RGB", shot.size, shot.rgb)
    elif a.image:
        img = Image.open(a.image).convert("RGB")
    else:
        sys.exit("Donne --grab ou --image fichier.png")
    middle = a.middle if a.middle is not None else a.grab
    W, H = img.size
    if a.crop:
        img = img.crop(tuple(map(int, a.crop.split(","))))
    elif middle:
        f = MIDDLE; img = img.crop((int(f[0] * W), int(f[1] * H), int(f[2] * W), int(f[3] * H)))
    load_weapons(a.weapons)
    cards = find_cards(img)
    if not cards:
        dbg = pathlib.Path(__file__).with_name("derniere_capture_ocr.png")   # ce que le script a réellement analysé
        img.save(dbg); print(f"Zone analysée enregistrée : {dbg}")
        sys.exit("Aucune carte détectée. Vérifie que l'onglet 'Unveiled rivens' est visible, ou ajuste --crop / le thème.")
    found = []
    for i, box in enumerate(cards, 1):
        card = img.crop(box)
        text = ocr(card, a.tesseract)
        if a.debug: print(f"--- carte {i} {box} ---\n{text}")
        rv = parse_card(text, read_rerolls(card, a.tesseract), read_weapon(card, a.tesseract))
        if rv: found.append(rv)
        else: print(f"carte {i} : illisible (relance avec --debug)")
    p = pathlib.Path(a.out)
    original = p.read_text(encoding="utf-8") if p.exists() else "[]"
    db = json.loads(original)
    key = lambda r: r["weapon_url_name"] + json.dumps(r["stats"], sort_keys=True)
    seen = {key(d) for d in db}; new = skipped = 0
    for r in found:
        if r["listed"] and not a.include_listed: skipped += 1; continue
        if key(r) not in seen: db.append(r); seen.add(key(r)); new += 1
    removed = []
    if a.prune:
        db, removed = prune_missing(db, found, len(cards))
        if removed:
            bak = p.with_name(p.name + ".bak"); bak.write_text(original, encoding="utf-8")
            for r in removed:
                print(f"Retiré (absent d'AlecaFrame) : {r.get('weapon')} {r.get('riven_name') or ''}".rstrip())
            print(f"Sauvegarde avant nettoyage : {bak}")
    p.write_text(json.dumps(db, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{len(cards)} carte(s), {len(found)} lue(s), {skipped} déjà listée(s) ignorée(s), {new} nouveau(x), "
          f"{len(removed)} retiré(s) -> {p}")

def ident(r):
    """Identité d'un riven tolérante aux petites erreurs d'OCR sur les valeurs : arme + stats (+/−), sans les nombres."""
    return (r.get("weapon_url_name"), tuple(sorted((s.get("stat"), bool(s.get("positive"))) for s in r.get("stats", []))))

def prune_missing(db, found, n_cards):
    """Retire de db les rivens qui n'apparaissent dans aucune carte lue. Renvoie (db_gardé, retirés).
    Garde-fous : rien n'est retiré si une carte est illisible (ce pourrait être lui) ;
    un riven avec auction_id (annonce en cours via l'outil) est toujours gardé."""
    if len(found) < n_cards:
        print(f"Nettoyage annulé : {n_cards - len(found)} carte(s) illisible(s), impossible de savoir quel riven a disparu.")
        return db, []
    visible = {ident(r) for r in found}             # y compris les cartes "Listed" non ajoutées
    keep, removed = [], []
    for d in db:
        if ident(d) in visible:
            keep.append(d)
        elif d.get("auction_id"):
            keep.append(d)
            print(f"Gardé malgré son absence (annonce en cours {d['auction_id']}) : {d.get('weapon')}")
        else:
            removed.append(d)
    return keep, removed

if __name__ == "__main__":
    main()