#!/usr/bin/env python3
"""
finderBot.py - pilote le "Riven finder" d'AlecaFrame (souris + OCR) pour chaque riven de rivens.json,
et relève : Lowest, nombre d'annonces, Average, Filtered average et les prix des annonces comparables.
Résultats ajoutés dans rivens.json (champ "finder") et finder_history.json (pour tracer ta courbe).

S'adapte à la taille/position de la fenêtre et au zoom : les champs sont repérés par leur TEXTE
("Positive 1", "Weapon"...) et l'échelle est mesurée à l'écran. Windows uniquement.

Installation : pip install pyautogui mss pillow pytesseract   (+ moteur Tesseract installé)
Usage :
  python finderBot.py --dry                 # DIAGNOSTIC : repère la fenêtre et lit l'écran, ne clique sur rien
  python finderBot.py rivens.json --only 0  # un seul riven (index 0) pour tester
  python finderBot.py rivens.json           # tous les rivens
Options : --start 5 (compte à rebours en s) --slow 1.5 (plus lent) --window "AlecaFrame"
          --debug-dir dossier (captures en cas d'échec)
ARRÊT D'URGENCE : envoie la souris dans un COIN de l'écran. Ne touche pas souris/clavier pendant l'exécution.
"""
import argparse, ctypes, datetime, difflib, json, os, pathlib, re, shutil, sys, time

# Stat (nom warframe.market) -> libellés possibles dans les listes d'AlecaFrame (à compléter si "stat non trouvée")
STAT_LABELS = {
    "critical_chance": ["Crit. chance", "Critical chance"], "critical_damage": ["Crit. damage", "Critical damage"],
    "multishot": ["Multishot"], "base_damage_/_melee_damage": ["Damage", "Melee damage", "Base damage"],
    "fire_rate_/_attack_speed": ["Fire Rate", "Attack speed"], "status_chance": ["Status Chance"],
    "status_duration": ["Status Duration"], "reload_speed": ["Reload speed"],
    "magazine_capacity": ["Magazine capacity", "Magazine"], "ammo_maximum": ["Ammo maximum", "Ammo Max"],
    "projectile_speed": ["Projectile speed"], "range": ["Range"], "punch_through": ["Punch through"],
    "zoom": ["Zoom"], "recoil": ["Recoil", "Weapon recoil"], "finisher_damage": ["Finisher damage"],
    "combo_duration": ["Combo duration"], "initial_combo": ["Initial combo"],
    "critical_chance_on_slide_attack": ["Slide crit. chance", "Crit. chance on slide attack"],
    "chance_to_gain_extra_combo_count": ["Extra combo chance", "Chance to gain extra combo count"],
    "heat_damage": ["Heat"], "cold_damage": ["Cold"], "electric_damage": ["Electricity"],
    "toxin_damage": ["Toxin"], "impact_damage": ["Impact"], "puncture_damage": ["Puncture"], "slash_damage": ["Slash"],
    "damage_vs_grineer": ["Damage vs Grineer", "Grineer"], "damage_vs_corpus": ["Damage vs Corpus", "Corpus"],
    "damage_vs_infested": ["Damage vs Infested", "Infested"],
}
ANY = ["Any attribute"]
# Distances de référence (px à l'échelle 100 %) mesurées sur tes captures
PITCH_POS = 91.0      # entre les libellés "Positive 1" et "Positive 2"
PITCH_NEG = 253.0     # entre "Positive 1" et "Negative"

class BotError(Exception):
    pass

# ============================ vision (OCR) ============================
def _tess():
    import pytesseract
    if not shutil.which("tesseract"):
        for p in (r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"):
            if os.path.exists(p):
                pytesseract.pytesseract.tesseract_cmd = p
                break
    return pytesseract

def norm(s):
    return re.sub(r"[^a-z0-9.]", "", s.lower())

def same(a, b, ratio=0.8):
    na, nb = norm(a), norm(b)
    if na == nb:
        return True
    if nb.isdigit() and na in ("l", "i", "|"):
        return nb == "1"
    return bool(na and nb and difflib.SequenceMatcher(None, na, nb).ratio() >= ratio)

def ocr_words(img, psm=11, up=2, offset=(0, 0)):
    from PIL import ImageOps
    pt = _tess()
    g = ImageOps.grayscale(img.convert("RGB"))
    g = ImageOps.invert(ImageOps.autocontrast(g.resize((g.width * up, g.height * up))))
    d = pt.image_to_data(g, config=f"--psm {psm}", output_type=pt.Output.DICT)
    out = []
    for i, t in enumerate(d["text"]):
        t = t.strip()
        if not t or float(d["conf"][i]) < 20:
            continue
        x, y, w, h = (d[k][i] / up for k in ("left", "top", "width", "height"))
        x += offset[0]; y += offset[1]
        out.append(dict(t=t, x=x, y=y, w=w, h=h, r=x + w, cx=x + w / 2, cy=y + h / 2))
    return out

def _union(ws):
    x = min(w["x"] for w in ws); y = min(w["y"] for w in ws)
    r = max(w["r"] for w in ws); b = max(w["y"] + w["h"] for w in ws)
    return dict(x=x, y=y, w=r - x, h=b - y, r=r, cx=(x + r) / 2, cy=(y + b) / 2)

def find_phrase(words, phrase, ratio=0.8):
    toks = phrase.split()
    found = []
    for w in words:
        if not same(w["t"], toks[0], ratio):
            continue
        chain, cur = [w], w
        for tk in toks[1:]:
            nxt = [v for v in words if v is not cur and abs(v["cy"] - cur["cy"]) < cur["h"] * 0.7
                   and 0 <= v["x"] - cur["r"] < cur["h"] * 2.5 and same(v["t"], tk, ratio)]
            if not nxt:
                chain = None
                break
            cur = min(nxt, key=lambda v: v["x"]); chain.append(cur)
        if chain:
            found.append(_union(chain))
    return found

def number_right(words, anchor, max_h=25):
    h = anchor["h"]
    c = [w for w in words if abs(w["cy"] - anchor["cy"]) < h * 0.8 and 0 <= w["x"] - anchor["r"] < h * max_h
         and re.fullmatch(r"\d[\d.,]*", w["t"])]
    if not c:
        return None
    t = min(c, key=lambda w: w["x"])["t"].replace(",", "")
    try:
        return float(t) if "." in t else int(t)
    except ValueError:
        return None

def rows_of(words):
    rows = []
    for w in sorted(words, key=lambda w: (w["cy"], w["x"])):
        if rows and abs(rows[-1]["cy"] - w["cy"]) < w["h"] * 0.6:
            rows[-1]["ws"].append(w)
        else:
            rows.append({"cy": w["cy"], "ws": [w]})
    for r in rows:
        r["ws"].sort(key=lambda w: w["x"])
        r["text"] = " ".join(w["t"] for w in r["ws"])
        r["cx"] = (min(w["x"] for w in r["ws"]) + max(w["r"] for w in r["ws"])) / 2
    return rows

def best_row(rows, candidates, min_score=0.82):
    best, score = None, 0.0
    for r in rows:
        for c in candidates:
            s = 1.0 if norm(r["text"]) == norm(c) else difflib.SequenceMatcher(None, norm(r["text"]), norm(c)).ratio()
            if s > score:
                best, score = r, s
    return best if score >= min_score else None

def locate_filters(words):
    """Repère les 4 libellés de filtres et mesure l'échelle d'affichage."""
    lab = {}
    for key, phrase in (("pos1", "Positive 1"), ("pos2", "Positive 2"), ("pos3", "Positive 3")):
        f = find_phrase(words, phrase)
        if f:
            lab[key] = f[0]
    if "pos1" not in lab:
        raise BotError("Libellé « Positive 1 » introuvable : le Riven finder est-il bien affiché ?")
    neg = [n for n in find_phrase(words, "Negative", 0.85) if abs(n["x"] - lab["pos1"]["x"]) < lab["pos1"]["h"] * 3 and n["y"] > lab["pos1"]["y"]]
    if neg:
        lab["neg"] = min(neg, key=lambda n: n["y"])
    if "pos2" in lab:
        s = (lab["pos2"]["cy"] - lab["pos1"]["cy"]) / PITCH_POS
    elif "neg" in lab:
        s = (lab["neg"]["cy"] - lab["pos1"]["cy"]) / PITCH_NEG
    else:
        raise BotError("Impossible de mesurer l'échelle (Positive 2 / Negative introuvables).")
    if not 0.4 < s < 4:
        raise BotError(f"Échelle aberrante ({s:.2f}) : lecture des libellés douteuse.")
    # un libellé manquant se déduit par la grille régulière
    if "pos2" not in lab:
        lab["pos2"] = dict(lab["pos1"], cy=lab["pos1"]["cy"] + PITCH_POS * s)
    if "pos3" not in lab:
        lab["pos3"] = dict(lab["pos1"], cy=lab["pos1"]["cy"] + 2 * PITCH_POS * s)
    if "neg" not in lab:
        lab["neg"] = dict(lab["pos1"], cy=lab["pos1"]["cy"] + PITCH_NEG * s)
    return lab, s

def field_point(label, s):
    return label["x"] + 80 * s, label["cy"] + 28 * s

def find_weapon_anchor(words, size):
    c = [w for w in find_phrase(words, "Weapon") if w["x"] > size[0] * 0.5 and w["y"] < size[1] * 0.25]
    if not c:
        raise BotError("Champ « Weapon » introuvable (en haut à droite du Finder).")
    return min(c, key=lambda w: w["y"])

def read_prices(words, s):
    out = {"lowest": None, "listings": None, "average": None, "filtered_average": None, "listing_prices": []}
    f = find_phrase(words, "Lowest", 0.85)
    if f:
        out["lowest"] = number_right(words, f[0], 30)
    m = find_phrase(words, "Matching listings", 0.8)
    if m:
        out["listings"] = number_right(words, m[0], 10)
    fa = find_phrase(words, "Filtered average", 0.8)
    if fa:
        out["filtered_average"] = number_right(words, fa[0], 12)
    for a in find_phrase(words, "average", 0.85):
        if any(abs(w["cy"] - a["cy"]) < a["h"] and 0 <= a["x"] - w["r"] < a["h"] * 2.5 and same(w["t"], "Filtered", 0.7) for w in words):
            continue                                  # c'est le mot de « Filtered average »
        v = number_right(words, a, 12)
        if v is not None:
            out["average"] = v
            break
    if m:
        rec = find_phrase(words, "Recommended", 0.8)
        y0, y1 = m[0]["cy"] + 20 * s, (rec[0]["y"] if rec else 1e9)
        srcs = [w for w in words if y0 < w["cy"] < y1 and (same(w["t"], "warframe.market", 0.85) or same(w["t"], "riven.market", 0.85))]
        srcs.sort(key=lambda w: (round(w["cy"] / (40 * s)), w["x"]))
        for w in srcs:
            v = number_right(words, w, 25)
            if v is not None:
                out["listing_prices"].append(v)
    return out

# ============================ pilote (souris/écran) ============================
class WinDriver:
    def __init__(self, rect):
        import mss, pyautogui
        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0.08
        self.pg, self.rect = pyautogui, rect
        self.sct = getattr(mss, "MSS", getattr(mss, "mss", None))()
    def grab(self):
        from PIL import Image
        l, t, r, b = self.rect
        shot = self.sct.grab({"left": l, "top": t, "width": r - l, "height": b - t})
        return Image.frombytes("RGB", shot.size, shot.rgb)
    def click(self, x, y):
        self.pg.click(self.rect[0] + x, self.rect[1] + y)
    def scroll(self, n, x, y):
        self.pg.moveTo(self.rect[0] + x, self.rect[1] + y); self.pg.scroll(n)
    def paste(self, text):
        import tkinter as tk
        root = tk.Tk(); root.withdraw(); root.clipboard_clear(); root.clipboard_append(text); root.update()
        self.pg.hotkey("ctrl", "a"); self.pg.hotkey("ctrl", "v"); root.destroy()   # presse-papiers : évite le souci AZERTY/QWERTY
    def key(self, k):
        self.pg.press(k)

def find_window(title_part):
    user32 = ctypes.windll.user32
    found = []
    Enum = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1); user32.GetWindowTextW(hwnd, buf, n + 1)
                if title_part.lower() in buf.value.lower():
                    found.append(hwnd)
        return True
    user32.EnumWindows(Enum(cb), 0)
    if not found:
        raise BotError(f"Fenêtre « {title_part} » introuvable. Ouvre AlecaFrame (pas réduit dans la barre des tâches).")
    class RECT(ctypes.Structure):
        _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long), ("r", ctypes.c_long), ("b", ctypes.c_long)]
    best = None
    for h in found:
        rc = RECT(); user32.GetWindowRect(h, ctypes.byref(rc))
        area = (rc.r - rc.l) * (rc.b - rc.t)
        if best is None or area > best[0]:
            best = (area, h, (rc.l, rc.t, rc.r, rc.b))
    _, hwnd, rect = best
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)
    user32.SetForegroundWindow(hwnd); time.sleep(0.6)
    rc = RECT(); user32.GetWindowRect(hwnd, ctypes.byref(rc))
    return hwnd, (max(rc.l, 0), max(rc.t, 0), rc.r, rc.b)

# ============================ le robot ============================
class FinderBot:
    def __init__(self, drv, slow=1.0, log=print, debug_dir=None):
        self.d, self.slow, self.log, self.debug_dir = drv, slow, log, debug_dir
    def wait(self, sec):
        time.sleep(sec * self.slow)
    def snap(self, psm=11):
        img = self.d.grab()
        return img, ocr_words(img, psm, 3 if img.width < 1400 else 2)
    def fail(self, msg, img=None):
        if self.debug_dir and img is not None:
            pathlib.Path(self.debug_dir).mkdir(exist_ok=True)
            img.save(pathlib.Path(self.debug_dir) / f"echec_{int(time.time())}.png")
        self.d.key("esc")
        raise BotError(msg)

    def ensure_finder(self):
        img, words = self.snap()
        if find_phrase(words, "Riven finder", 0.8):
            return
        side = [w for w in find_phrase(words, "Rivens", 0.85) if w["x"] < img.width * 0.2]
        if not side:
            self.fail("Je ne vois ni le Finder ni le menu « Rivens ». Ouvre Rivens > Finder à la main.", img)
        self.d.click(side[0]["cx"], side[0]["cy"]); self.wait(0.8)
        img, words = self.snap()
        fin = [w for w in find_phrase(words, "Finder", 0.85) if w["x"] < img.width * 0.35 and w["cy"] > side[0]["cy"]]
        if not fin:
            self.fail("Menu « Finder » introuvable après avoir cliqué sur Rivens.", img)
        self.d.click(fin[0]["cx"], fin[0]["cy"]); self.wait(1.2)
        img, words = self.snap()
        if not find_phrase(words, "Riven finder", 0.8):
            self.fail("Le Finder ne s'est pas ouvert.", img)

    def pick_from_list(self, region, candidates, what):
        """Dans une liste déroulante : remonte en haut, puis fait défiler jusqu'à trouver l'entrée."""
        x0, y0, x1, y1 = [int(v) for v in region]
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        self.d.scroll(30, cx, cy); self.wait(0.3)
        seen, last = [], None
        for _ in range(16):
            img = self.d.grab().crop((x0, y0, x1, y1))
            rows = rows_of(ocr_words(img, 11, 2, (x0, y0)))
            hit = best_row(rows, candidates)
            if hit:
                self.d.click(hit["cx"], hit["cy"]); self.wait(0.5)
                return
            texts = tuple(r["text"] for r in rows)
            seen += [t for t in texts if t not in seen]
            if texts == last:
                break                                          # fin de liste
            last = texts
            self.d.scroll(-3, cx, cy); self.wait(0.35)
        self.fail(f"{what} : « {' / '.join(candidates)} » introuvable dans la liste. Entrées vues : {seen[:25]}", self.d.grab())

    def current_text(self, label, s, width=215):
        img = self.d.grab()
        box = (int(label["x"]), int(label["cy"] + 12 * s), int(label["x"] + width * s), int(label["cy"] + 46 * s))
        ws = ocr_words(img.crop(box), 7, 3)
        return " ".join(w["t"] for w in sorted(ws, key=lambda w: w["x"]))

    def set_weapon(self, name):
        img, words = self.snap()
        anchor = find_weapon_anchor(words, img.size)
        _, s = locate_filters(words)
        self.d.click(anchor["x"] + 30 * s, anchor["cy"] + 16 * s); self.wait(0.7)
        self.d.paste(name); self.wait(1.0)
        img = self.d.grab()
        region = (anchor["x"] - 75 * s, anchor["cy"] + 80 * s, anchor["x"] + 243 * s, anchor["cy"] + 385 * s)
        rows = rows_of(ocr_words(img.crop([int(v) for v in region]), 11, 2, (int(region[0]), int(region[1]))))
        hit = best_row(rows, [name], 0.9)
        if not hit:
            self.fail(f"Arme « {name} » introuvable dans la recherche. Lignes vues : {[r['text'] for r in rows][:10]}", img)
        self.d.click(hit["cx"], hit["cy"]); self.wait(1.2)
        img, words = self.snap()
        ws = [w for w in ocr_words(img.crop((int(anchor["x"] - 10 * s), int(anchor["cy"] + 5 * s), int(anchor["x"] + 240 * s), int(anchor["cy"] + 34 * s))), 7, 3)]
        got = " ".join(w["t"] for w in ws)
        if not same(got, name, 0.8) and norm(name) not in norm(got):
            self.fail(f"Arme non sélectionnée (lu : « {got} », attendu : « {name} »).", img)

    def set_slot(self, key, candidates, s_hint=None):
        img, words = self.snap()
        labs, s = locate_filters(words)
        lab = labs[key]
        fx, fy = field_point(lab, s)
        self.d.click(fx, fy); self.wait(0.5)
        region = (lab["x"] - 4 * s, lab["cy"] + 44 * s, lab["x"] + 236 * s, lab["cy"] + 330 * s)
        self.pick_from_list(region, candidates, f"Filtre {key}")
        labs, s = locate_filters(self.snap()[1])
        got = self.current_text(labs[key], s)
        if not any(same(got, c, 0.75) or norm(c) in norm(got) for c in candidates):
            self.fail(f"Filtre {key} : lu « {got} », attendu « {candidates[0]} ».", self.d.grab())

    def slot_is_any(self, key):
        labs, s = locate_filters(self.snap()[1])
        return same(self.current_text(labs[key], s), "Any attribute", 0.75)

    def measure(self, riven):
        pos = riven["pos"][:3]
        neg = riven["neg"][:1]
        for st in pos + neg:
            if st not in STAT_LABELS:
                raise BotError(f"Stat « {st} » sans libellé AlecaFrame connu (ajoute-la à STAT_LABELS).")
        self.ensure_finder()
        self.set_weapon(riven["weapon"])
        for key in ("neg", "pos3", "pos2", "pos1"):           # on vide d'abord (évite les conflits entre slots)
            if not self.slot_is_any(key):
                self.set_slot(key, ANY)
        for key, st in zip(("pos1", "pos2", "pos3"), pos):
            self.set_slot(key, STAT_LABELS[st])
        if neg:
            self.set_slot("neg", STAT_LABELS[neg[0]])
        self.wait(2.0)
        img, words = self.snap()
        labs, s = locate_filters(words)
        res = read_prices(words, s)
        if res["filtered_average"] is None:                    # panneau « Price history & trends » masqué ?
            tab = find_phrase(words, "Price history & trends", 0.75) or find_phrase(words, "Price history", 0.8)
            if tab:
                self.d.click(tab[0]["cx"], tab[0]["cy"]); self.wait(1.5)
                img, words = self.snap()
                res = read_prices(words, s)
        if res["lowest"] is None and res["filtered_average"] is None:
            self.fail("Aucun prix lu à l'écran.", img)
        res["date"] = datetime.datetime.now().isoformat(timespec="seconds")
        return res

def key_of(r):
    return f"{r['weapon_url_name']}|{','.join(sorted(r['pos']))}|{','.join(sorted(r['neg']))}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json", nargs="?", default="rivens.json")
    ap.add_argument("--only", type=int, nargs="*", help="index(es) des rivens à traiter")
    ap.add_argument("--dry", action="store_true"); ap.add_argument("--start", type=int, default=5)
    ap.add_argument("--slow", type=float, default=1.0); ap.add_argument("--window", default="AlecaFrame")
    ap.add_argument("--debug-dir")
    a = ap.parse_args()
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)        # coordonnées en vrais pixels (écrans mis à l'échelle)
    except Exception:
        ctypes.windll.user32.SetProcessDPIAware()
    hwnd, rect = find_window(a.window)
    print(f"Fenêtre AlecaFrame : {rect[2]-rect[0]}x{rect[3]-rect[1]} px")
    drv = WinDriver(rect)
    bot = FinderBot(drv, a.slow, debug_dir=a.debug_dir)
    if a.dry:
        img, words = bot.snap()
        try:
            labs, s = locate_filters(words)
            print(f"Échelle mesurée : {s:.2f}  | libellés : {', '.join(labs)}")
            print("Arme :", find_weapon_anchor(words, img.size) is not None)
        except BotError as e:
            print("Diagnostic :", e)
        print("Lecture :", read_prices(words, s if 's' in dir() else 1.0))
        print("(mode --dry : aucun clic effectué)")
        return
    p = pathlib.Path(a.json)
    rivens = json.loads(p.read_text(encoding="utf-8"))
    hist_p = p.with_name("finder_history.json")
    hist = json.loads(hist_p.read_text(encoding="utf-8")) if hist_p.exists() else []
    todo = [i for i in (a.only if a.only else range(len(rivens)))]
    print(f"{len(todo)} riven(s). Départ dans {a.start}s : ne touche plus à la souris. Coin d'écran = arrêt d'urgence.")
    time.sleep(a.start)
    find_window(a.window)
    for n, i in enumerate(todo, 1):
        r = rivens[i]
        try:
            res = bot.measure(r)
        except BotError as e:
            print(f"[{n}/{len(todo)}] {r['weapon']} : ÉCHEC – {e}")
            continue
        r["finder"] = res
        hist.append({"key": key_of(r), **res})
        p.write_text(json.dumps(rivens, indent=2, ensure_ascii=False), encoding="utf-8")
        hist_p.write_text(json.dumps(hist), encoding="utf-8")
        print(f"[{n}/{len(todo)}] {r['weapon']} : lowest {res['lowest']} | filtered avg {res['filtered_average']} | "
              f"avg {res['average']} | {res['listings']} annonces | prix {res['listing_prices']}")

if __name__ == "__main__":
    main()