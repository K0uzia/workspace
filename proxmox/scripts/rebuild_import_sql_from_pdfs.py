#!/usr/bin/env python3
"""
Reconstruit un import SQL (PostgreSQL) à partir des PDFs présents sur /mnt/team/#TEAM/.

Objectif:
- Générer un fichier import.sql pour réinsérer des enregistrements dans la DB (commandes/lots/disques/dons/prêts).
- Sans --parse-* : uniquement chemins + noms de fichiers (pas de lecture du contenu PDF).
- Avec --parse-all-pdf (ou --parse-*-pdf) : tableaux extraits via pdftotext ; les PDFs doivent être
  accessibles sur la machine où tu lances ce script (souvent ton poste ou un serveur avec /mnt/team).

Workflow typique « CT sans PDF »:
1) Sur une machine où les PDFs existent : python3 proxmox/scripts/rebuild_import_sql_from_pdfs.py --parse-all-pdf --out import.sql
2) git add import.sql && git commit && git push
3) Sur le CT : git pull puis sudo bash proxmox/scripts/proxmox.sh update (injecte import.sql à la racine du repo).
   Le CT n’a pas besoin des PDFs ni de relancer le script Python : seul import.sql est requis côté CT.

Règle métier : 1 fichier PDF = 1 enregistrement (lot, don, etc.). Le chemin du dossier fait partie de l’identité
(chemins différents = lots / typologies différents même si le nom de fichier se ressemble).

Hypothèses de nommage fournies:
- Commandes: /mnt/team/#TEAM/#COMMANDES/Chargeur/<categorie>/*.pdf  (nom: nom_date.pdf)
- Lots:      /mnt/team/#TEAM/#TRAÇABILITÉ/<année>/<mois>/*.pdf     (nom: nom_date.pdf)
- Disques:   /mnt/team/#TEAM/#TRAÇABILITÉ/Disques/<année>/<mois>/*.pdf (nom: nom_date.pdf)
- Dons:      /mnt/team/#TEAM/#TRAÇABILITÉ/don_stagiaires/<année>/<mois>/*.pdf (nom: nom_date_heure.pdf)
- Prêts:     /mnt/team/#TEAM/#TRAÇABILITÉ/prets_materiel/<année>/<mois>/*.pdf (nom: nom_date.pdf)

⚠️ Si le backend sur le CT n’a pas /mnt/team, les pdf_path dans la DB pointeront vers des chemins inexistants
  sur le CT (404 côté API) : prévoir une copie des PDFs ou des chemins adaptés si les liens doivent marcher en prod.
"""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Tuple, List

import json
import subprocess
from datetime import datetime
from decimal import Decimal, InvalidOperation


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{2}-\d{2}-\d{2}$")


def pick_existing_dir(base: Path, candidates: List[str]) -> Optional[Path]:
    for name in candidates:
        p = base / name
        if p.exists() and p.is_dir():
            return p
    return None


def find_dir_recursive(base: Path, wanted_names: List[str]) -> Optional[Path]:
    wanted = {w.lower() for w in wanted_names}
    if not base.exists():
        return None
    for p in base.rglob("*"):
        if p.is_dir() and p.name.lower() in wanted:
            return p
    return None


def sql_literal(s: Optional[str]) -> str:
    if s is None:
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def sql_date(d: Optional[str]) -> str:
    if not d:
        return "NULL"
    return sql_literal(d[:10])


def parse_name_date_from_stem(stem: str) -> Tuple[str, Optional[str], Optional[str]]:
    """
    Retourne (name, yyyy-mm-dd, hh-mm-ss?)
    - stem est le nom de fichier sans extension.
    """
    parts = [p for p in stem.split("_") if p != ""]

    # Certains fichiers finissent par un suffixe d'unicité: _2, _(1), _copie, etc.
    # On retire uniquement les suffixes "évidents" (numériques / parenthèses numériques).
    while parts and (re.fullmatch(r"\d+", parts[-1]) or re.fullmatch(r"\(\d+\)", parts[-1])):
        parts = parts[:-1]

    # Cas date+heure (éventuellement suivi d'un suffixe supprimé ci-dessus)
    if len(parts) >= 2 and DATE_RE.fullmatch(parts[-2]) and TIME_RE.fullmatch(parts[-1]):
        d = parts[-2]
        t = parts[-1]
        name = "_".join(parts[:-2]).rstrip("_- ").strip()
        return (name or "document", d, t)

    # Cas date seule: on prend la dernière occurrence de YYYY-MM-DD depuis la fin
    for i in range(len(parts) - 1, -1, -1):
        if DATE_RE.fullmatch(parts[i]):
            d = parts[i]
            name = "_".join(parts[:i]).rstrip("_- ").strip()
            return (name or "document", d, None)

    # Fallback: aucune date détectable dans le nom
    return (stem.strip() or "document", None, None)


def iter_pdfs(root: Path) -> Iterable[Path]:
    if not root.exists():
        return
    for p in root.rglob("*.pdf"):
        if p.is_file():
            yield p


def normalize_month_folder(name: str) -> str:
    # On ne dépend pas du nom (Janvier/Février) puisque le fichier contient déjà la date.
    return name


@dataclass
class CommandeRow:
    name: str
    category: str
    date: str
    pdf_path: str
    lines: List[dict]


@dataclass
class LotRow:
    name: str
    date: str
    pdf_path: str
    items: List[dict]


@dataclass
class DisqueSessionRow:
    name: str
    date: str
    pdf_path: str
    disks: List[dict]


@dataclass
class DonRow:
    lot_name: str
    date: str
    pdf_path: str
    lines: List[dict]


@dataclass
class PretRow:
    reference: Optional[str]
    borrower_name: str
    date: str
    pdf_path: str
    lines_json: str


def build_commandes_rows(commandes_root: Path) -> List[CommandeRow]:
    rows: List[CommandeRow] = []
    if not commandes_root.exists():
        return rows
    # Structure réelle observée: souvent commandes_root/<categorie...>/*.pdf (parfois profond: alcool/chargeur/RJ45)
    for pdf in iter_pdfs(commandes_root):
        name, d, _t = parse_name_date_from_stem(pdf.stem)
        if not d:
            continue
        rel_parent = pdf.parent.relative_to(commandes_root)
        category = str(rel_parent) if str(rel_parent) != "." else "Divers"
        rows.append(CommandeRow(name=name, category=category, date=d, pdf_path=str(pdf), lines=[]))
    return rows


def build_simple_rows(base: Path) -> List[LotRow]:
    rows: List[LotRow] = []
    for pdf in iter_pdfs(base):
        name, d, _t = parse_name_date_from_stem(pdf.stem)
        if not d:
            continue
        rows.append(LotRow(name=name, date=d, pdf_path=str(pdf), items=[]))
    return rows


def build_disques_rows(base: Path) -> List[DisqueSessionRow]:
    rows: List[DisqueSessionRow] = []
    for pdf in iter_pdfs(base):
        name, d, _t = parse_name_date_from_stem(pdf.stem)
        if not d:
            continue
        rows.append(DisqueSessionRow(name=name, date=d, pdf_path=str(pdf), disks=[]))
    return rows


def build_dons_rows(base: Path) -> List[DonRow]:
    rows: List[DonRow] = []
    for pdf in iter_pdfs(base):
        name, d, _t = parse_name_date_from_stem(pdf.stem)
        if not d:
            continue
        # lot_name vide possible, mais on garde le "name" du fichier
        rows.append(DonRow(lot_name=name, date=d, pdf_path=str(pdf), lines=[]))
    return rows


def build_prets_rows(base: Path) -> List[PretRow]:
    rows: List[PretRow] = []
    for pdf in iter_pdfs(base):
        name, d, _t = parse_name_date_from_stem(pdf.stem)
        if not d:
            continue
        # On ne peut pas déduire borrower_name autrement : on utilise le nom de fichier.
        rows.append(PretRow(reference=None, borrower_name=name, date=d, pdf_path=str(pdf), lines_json="[]"))
    return rows


def try_extract_text_from_pdf(pdf_path: Path) -> Optional[str]:
    """
    Extraction best-effort:
    - essaie `pdftotext` (souvent dispo sur Linux)
    - sinon None
    """
    try:
        proc = subprocess.run(
            ["pdftotext", "-layout", str(pdf_path), "-"],
            check=False,
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout
    except FileNotFoundError:
        return None
    except Exception:
        return None
    return None


def parse_price_to_decimal(value: str) -> Optional[str]:
    v = (value or "").strip()
    if not v:
        return None
    v = v.replace("€", "").replace("EUR", "").strip()
    v = v.replace("\u00a0", " ")
    v = v.replace(" ", "")
    # 12,34 -> 12.34
    if v.count(",") == 1 and v.count(".") == 0:
        v = v.replace(",", ".")
    # "12.34" ok ; "12,34" handled ; otherwise best-effort
    try:
        d = Decimal(v)
        return format(d, "f")
    except (InvalidOperation, ValueError):
        return None


def split_layout_columns(line: str) -> List[str]:
    return [c.strip() for c in re.split(r"\s{2,}", line.rstrip()) if c.strip()]


def find_table_start(raw_lines: List[str], required_tokens: List[str]) -> Optional[int]:
    req = [t.lower() for t in required_tokens]
    for i, ln in enumerate(raw_lines):
        low = ln.lower()
        if all(t in low for t in req):
            return i
    return None


def parse_prets_from_text(text: str) -> Tuple[Optional[str], Optional[str], List[dict]]:
    """
    Heuristique pour PDF "prêt matériel":
    - récupère borrower_name si on trouve une ligne type "Emprunteur" / "Bénéficiaire"
    - récupère reference si présent
    - récupère les lignes de tableau en cherchant une zone avec colonnes (Réf / Désignation / Qté)
    """
    borrower = None
    reference = None

    # champs simples
    m = re.search(r"(Emprunteur|B[ée]n[ée]ficiaire)\s*:\s*(.+)", text, flags=re.IGNORECASE)
    if m:
        borrower = m.group(2).strip()
    m = re.search(r"(R[ée]f[ée]rence|Reference)\s*:\s*(.+)", text, flags=re.IGNORECASE)
    if m:
        reference = m.group(2).strip()

    lines: List[dict] = []

    # tableau (selon template client): N° | Type | Marque | Modèle | S/N | Qté
    raw_lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    header_idx = None
    for i, ln in enumerate(raw_lines):
        low = ln.lower()
        if ("qt" in low or "qté" in low or "quant" in low) and ("s/n" in low or "sn" in low) and "mod" in low and "marque" in low and "type" in low:
            header_idx = i
            break

    if header_idx is None:
        return (borrower, reference, lines)

    # On consomme jusqu'à une ligne de total/signature (très variable). On s'arrête si on voit "Signature" ou "Total".
    for ln in raw_lines[header_idx + 1 :]:
        low = ln.lower()
        if "signature" in low or low.startswith("total"):
            break
        # split colonnes par gros espaces (pdftotext -layout garde souvent des blocs)
        cols = split_layout_columns(ln)
        if len(cols) < 3:
            continue
        # Mapping attendu: N°, Type, Marque, Modèle, S/N, Qté
        # Si on a plus/moins de colonnes, on fait au mieux.
        numero = None
        qty = None

        # qty en fin
        if cols and re.fullmatch(r"\d+", cols[-1]):
            qty = int(cols[-1])
            cols = cols[:-1]

        # numero en début
        if cols and re.fullmatch(r"\d+", cols[0]):
            numero = int(cols[0])
            cols = cols[1:]

        # le reste: type, marque, modele, sn (sn peut contenir espaces, on prend ce qu'il reste)
        type_v = cols[0] if len(cols) >= 1 else None
        marque_v = cols[1] if len(cols) >= 2 else None
        modele_v = cols[2] if len(cols) >= 3 else None
        sn_v = " ".join(cols[3:]).strip() if len(cols) >= 4 else None

        item: dict = {}
        if numero is not None:
            item["numero"] = numero
        if type_v:
            item["type"] = type_v
        if marque_v:
            item["marque_name"] = marque_v
        if modele_v:
            item["modele_name"] = modele_v
        if sn_v:
            item["serial_number"] = sn_v
        if qty is not None:
            item["qty"] = qty

        if item:
            lines.append(item)

    return (borrower, reference, lines)


def build_prets_rows_with_pdf_parse(base: Path) -> List[PretRow]:
    rows: List[PretRow] = []
    for pdf in iter_pdfs(base):
        borrower_name, d, _t = parse_name_date_from_stem(pdf.stem)
        if not d:
            continue
        extracted_text = try_extract_text_from_pdf(pdf)
        if extracted_text:
            borrower2, reference2, lines = parse_prets_from_text(extracted_text)
            borrower_name = borrower2 or borrower_name
            reference = reference2
            lines_json = json.dumps(lines, ensure_ascii=False)
        else:
            reference = None
            lines_json = "[]"
        rows.append(
            PretRow(
                reference=reference,
                borrower_name=borrower_name,
                date=d,
                pdf_path=str(pdf),
                lines_json=lines_json,
            )
        )
    return rows


def parse_dons_from_text(text: str) -> List[dict]:
    """
    Template dons: N° | Type | Marque | Modèle | S/N | Date | Stagiaire AFPA | Signature
    Signature est vide côté PDF.
    """
    raw_lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    header_idx = find_table_start(raw_lines, ["Type", "Marque", "Mod", "S/N"])
    if header_idx is None:
        return []
    out: List[dict] = []
    for ln in raw_lines[header_idx + 1 :]:
        low = ln.lower()
        if "signature" in low:
            break
        cols = split_layout_columns(ln)
        if len(cols) < 5:
            continue
        # attente: num, type, marque, modele, sn, date, stagiaire
        num = None
        if cols and re.fullmatch(r"\d+", cols[0]):
            num = int(cols[0])
            cols = cols[1:]
        type_v = cols[0] if len(cols) >= 1 else None
        marque_v = cols[1] if len(cols) >= 2 else None
        modele_v = cols[2] if len(cols) >= 3 else None
        sn_v = cols[3] if len(cols) >= 4 else None
        date_v = cols[4] if len(cols) >= 5 else None
        stagiaire_v = " ".join(cols[5:]).strip() if len(cols) >= 6 else None
        row: dict = {}
        if num is not None:
            row["num"] = num
        if type_v:
            row["type"] = type_v
        if marque_v:
            row["marqueName"] = marque_v
        if modele_v:
            row["modeleName"] = modele_v
        if sn_v:
            row["serialNumber"] = sn_v
        if date_v:
            row["date"] = date_v
        if stagiaire_v:
            row["stagiaire"] = stagiaire_v
        if row:
            out.append(row)
    return out


def parse_disques_from_text(text: str) -> List[dict]:
    """
    Template disques: (checkbox) | N° | S/N | Marque | Modèle | Taille | Type | Interface | Shred
    """
    raw_lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    header_idx = find_table_start(raw_lines, ["S/N", "Marque", "Mod", "Taille"])
    if header_idx is None:
        return []
    out: List[dict] = []
    for ln in raw_lines[header_idx + 1 :]:
        low = ln.lower()
        if "méthode" in low or "methode" in low:
            break
        cols = split_layout_columns(ln)
        if len(cols) < 6:
            continue
        # Il peut y avoir une première colonne vide/checkbox. Si la première colonne n'est pas un numéro, on la drop.
        if cols and not re.fullmatch(r"\d+", cols[0]) and len(cols) >= 2 and re.fullmatch(r"\d+", cols[1]):
            cols = cols[1:]
        num = None
        if cols and re.fullmatch(r"\d+", cols[0]):
            num = int(cols[0])
            cols = cols[1:]
        sn = cols[0] if len(cols) >= 1 else None
        marque = cols[1] if len(cols) >= 2 else None
        modele = cols[2] if len(cols) >= 3 else None
        size = cols[3] if len(cols) >= 4 else None
        disk_type = cols[4] if len(cols) >= 5 else None
        interface = cols[5] if len(cols) >= 6 else None
        shred = " ".join(cols[6:]).strip() if len(cols) >= 7 else None
        row: dict = {}
        if num is not None:
            row["num"] = num
        if sn:
            row["serial"] = sn
        if marque:
            row["marque"] = marque
        if modele:
            row["modele"] = modele
        if size:
            row["size"] = size
        if disk_type:
            row["disk_type"] = disk_type
        if interface:
            row["interface"] = interface
        if shred:
            row["shred"] = shred
        if row:
            out.append(row)
    return out


def parse_lot_items_from_text(text: str) -> List[dict]:
    """
    Template lot: N° | Type | Marque | Modèle | OS | S/N | État | Date | Technicien
    """
    raw_lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    header_idx = find_table_start(raw_lines, ["Type", "Marque", "Mod", "OS", "S/N"])
    if header_idx is None:
        return []
    out: List[dict] = []
    for ln in raw_lines[header_idx + 1 :]:
        low = ln.lower()
        if "résumé" in low or "resume" in low:
            continue
        if "détail" in low or "detail" in low:
            continue
        cols = split_layout_columns(ln)
        if len(cols) < 6:
            continue
        num = None
        if cols and re.fullmatch(r"\d+", cols[0]):
            num = int(cols[0])
            cols = cols[1:]
        type_v = cols[0] if len(cols) >= 1 else None
        marque_v = cols[1] if len(cols) >= 2 else None
        modele_v = cols[2] if len(cols) >= 3 else None
        os_v = cols[3] if len(cols) >= 4 else None
        sn_v = cols[4] if len(cols) >= 5 else None
        state_v = cols[5] if len(cols) >= 6 else None
        date_v = cols[6] if len(cols) >= 7 else None
        tech_v = " ".join(cols[7:]).strip() if len(cols) >= 8 else None

        row: dict = {}
        if num is not None:
            row["numero"] = num
        if sn_v:
            row["serial_number"] = sn_v
        if type_v:
            row["type"] = type_v
        if marque_v:
            row["marque_name"] = marque_v
        if modele_v:
            row["modele_name"] = modele_v
        if os_v:
            row["os"] = os_v
        if state_v:
            row["state"] = state_v
        if tech_v:
            row["technician"] = tech_v
        if date_v:
            row["date_display"] = date_v
        if row:
            out.append(row)
    return out


def parse_commande_lines_from_text(text: str) -> List[dict]:
    """
    Template commande: N° | Produit | Quantité | Prix | [Frais de port] | Liens
    """
    raw_lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    header_idx = find_table_start(raw_lines, ["Produit", "Quant", "Prix"])
    if header_idx is None:
        return []
    header_low = raw_lines[header_idx].lower()
    has_shipping = "frais" in header_low and "port" in header_low
    out: List[dict] = []
    for ln in raw_lines[header_idx + 1 :]:
        cols = split_layout_columns(ln)
        if len(cols) < 4:
            continue
        num = None
        if cols and re.fullmatch(r"\d+", cols[0]):
            num = int(cols[0])
            cols = cols[1:]
        produit = cols[0] if len(cols) >= 1 else None
        quantite = cols[1] if len(cols) >= 2 else None
        prix = cols[2] if len(cols) >= 3 else None
        idx = 3
        shipping = None
        if has_shipping and len(cols) > idx:
            shipping = cols[idx]
            idx += 1
        link = " ".join(cols[idx:]).strip() if len(cols) > idx else None
        row: dict = {}
        if num is not None:
            row["num"] = num
        if produit:
            row["produit"] = produit
        if quantite:
            row["quantity"] = quantite
        if prix:
            row["price"] = prix
        if shipping:
            row["shipping"] = shipping
        if link:
            row["link"] = link
        if row:
            out.append(row)
    return out


def build_rows_with_pdf_parse(
    commandes: List[CommandeRow],
    lots: List[LotRow],
    disques: List[DisqueSessionRow],
    dons: List[DonRow],
    parse_commandes: bool,
    parse_lots: bool,
    parse_disques: bool,
    parse_dons: bool,
) -> Tuple[List[CommandeRow], List[LotRow], List[DisqueSessionRow], List[DonRow]]:
    if parse_commandes:
        for r in commandes:
            txt = try_extract_text_from_pdf(Path(r.pdf_path))
            r.lines = parse_commande_lines_from_text(txt) if txt else []
    if parse_lots:
        for r in lots:
            txt = try_extract_text_from_pdf(Path(r.pdf_path))
            r.items = parse_lot_items_from_text(txt) if txt else []
    if parse_disques:
        for r in disques:
            txt = try_extract_text_from_pdf(Path(r.pdf_path))
            r.disks = parse_disques_from_text(txt) if txt else []
    if parse_dons:
        for r in dons:
            txt = try_extract_text_from_pdf(Path(r.pdf_path))
            r.lines = parse_dons_from_text(txt) if txt else []
    return commandes, lots, disques, dons


def emit_sql(
    commandes: List[CommandeRow],
    lots: List[LotRow],
    disques: List[DisqueSessionRow],
    dons: List[DonRow],
    prets: List[PretRow],
    wipe: bool,
) -> str:
    lines: List[str] = []
    lines.append("-- import.sql généré par rebuild_import_sql_from_pdfs.py")
    lines.append("BEGIN;")
    lines.append("")
    if wipe:
        # Nettoyage dans un ordre qui respecte les FK les plus probables
        lines.append("-- ⚠️ Wipe demandé: suppression des données existantes")
        lines.append("TRUNCATE TABLE commande_lignes RESTART IDENTITY CASCADE;")
        lines.append("TRUNCATE TABLE commandes RESTART IDENTITY CASCADE;")
        lines.append("TRUNCATE TABLE dons RESTART IDENTITY CASCADE;")
        lines.append("TRUNCATE TABLE disques_session_disks RESTART IDENTITY CASCADE;")
        lines.append("TRUNCATE TABLE disques_sessions RESTART IDENTITY CASCADE;")
        lines.append("TRUNCATE TABLE lot_items RESTART IDENTITY CASCADE;")
        lines.append("TRUNCATE TABLE lots RESTART IDENTITY CASCADE;")
        lines.append("TRUNCATE TABLE prets_materiel RESTART IDENTITY CASCADE;")
        lines.append("")

    # Commandes
    lines.append("-- Commandes")
    for r in sorted(commandes, key=lambda x: (x.date, x.category, x.name)):
        if r.lines:
            cmd_id_sub = (
                f"(SELECT id FROM commandes WHERE pdf_path = {sql_literal(r.pdf_path)} ORDER BY id DESC LIMIT 1)"
            )
            ins_cte = (
                "WITH ins AS ("
                " INSERT INTO commandes (user_id, name, category, date, pdf_path, created_at)"
                f" VALUES (NULL, {sql_literal(r.name)}, {sql_literal(r.category)}, {sql_date(r.date)}, {sql_literal(r.pdf_path)}, NOW())"
                " RETURNING id"
                ")"
            )
            for idx, ln in enumerate(r.lines):
                qty_raw = str(ln.get("quantity", "")).strip()
                qty = int(qty_raw) if re.fullmatch(r"\d+", qty_raw or "") else 1
                unit_price = parse_price_to_decimal(str(ln.get("price", "") or ""))
                ship_price = parse_price_to_decimal(str(ln.get("shipping", "") or ""))
                product_name = str(ln.get("produit", "") or "").strip() or None
                link = str(ln.get("link", "") or "").strip() or None
                cid = "ins.id" if idx == 0 else cmd_id_sub
                ins_from = " FROM ins" if idx == 0 else ""
                if idx == 0:
                    lines.append(
                        ins_cte
                        + "\nINSERT INTO commande_lignes (commande_id, product_name, quantity, unit_price, shipping_cost, link, created_at)"
                        f" SELECT {cid}, "
                        f"{sql_literal(product_name)}, {qty}, {sql_literal(unit_price)}::numeric, {sql_literal(ship_price)}::numeric, {sql_literal(link)}, NOW()"
                        f"{ins_from};"
                    )
                else:
                    lines.append(
                        "INSERT INTO commande_lignes (commande_id, product_name, quantity, unit_price, shipping_cost, link, created_at)"
                        f" SELECT {cmd_id_sub}, "
                        f"{sql_literal(product_name)}, {qty}, {sql_literal(unit_price)}::numeric, {sql_literal(ship_price)}::numeric, {sql_literal(link)}, NOW();"
                    )
        else:
            lines.append(
                "INSERT INTO commandes (user_id, name, category, date, pdf_path, created_at) VALUES "
                f"(NULL, {sql_literal(r.name)}, {sql_literal(r.category)}, {sql_date(r.date)}, {sql_literal(r.pdf_path)}, NOW());"
            )
    lines.append("")

    # Lots (traçabilité)
    lines.append("-- Lots (traçabilité)")
    for r in sorted(lots, key=lambda x: (x.date, x.name)):
        # item_count inconnu -> 0 ; status -> finished (ou received). On met received pour coller à réception.
        item_count = len(r.items) if r.items else 0
        if r.items:
            lot_id_sub = (
                f"(SELECT id FROM lots WHERE pdf_path = {sql_literal(r.pdf_path)} ORDER BY id DESC LIMIT 1)"
            )
            ins_lot_cte = (
                "WITH ins_lot AS ("
                " INSERT INTO lots (user_id, name, status, item_count, description, received_at, finished_at, recovered_at, pdf_path, created_at, updated_at)"
                f" VALUES (NULL, {sql_literal(r.name)}, 'received', {item_count}, NULL, {sql_literal(r.date)}::date, NULL, NULL, {sql_literal(r.pdf_path)}, NOW(), NOW())"
                " RETURNING id"
                ")"
            )
            for idx, it in enumerate(r.items):
                sn = (it.get("serial_number") or "").strip() or None
                type_v = (it.get("type") or "").strip() or None
                marque_name = (it.get("marque_name") or "").strip() or None
                modele_name = (it.get("modele_name") or "").strip() or None
                state_v = (it.get("state") or "").strip() or None
                tech = (it.get("technician") or "").strip() or None
                date_disp = (it.get("date_display") or "").strip()
                entry_date = None
                entry_time = None
                m = re.search(r"(\d{2})/(\d{2})/(\d{4})", date_disp)
                if m:
                    dd, mm, yyyy = m.groups()
                    entry_date = f"{yyyy}-{mm}-{dd}"
                    m2 = re.search(r"(\d{2}):(\d{2})", date_disp)
                    if m2:
                        hh, mi = m2.groups()
                        entry_time = f"{hh}:{mi}:00"
                lot_id_expr = "ins_lot.id" if idx == 0 else lot_id_sub
                lot_from = " FROM ins_lot" if idx == 0 else ""
                # Crée/cherche marque
                if marque_name:
                    modele_name_lit = sql_literal(modele_name) if modele_name else "NULL"
                    should_insert_modele = "NOT EXISTS (SELECT 1 FROM modele)" if modele_name else "false"
                    modele_id_expr = "(SELECT id FROM modele_id LIMIT 1)" if modele_name else "NULL"
                    marque_chain = (
                        "WITH marque AS ("
                        "  INSERT INTO marques(name) VALUES "
                        f"  ({sql_literal(marque_name)})"
                        "  ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name"
                        "  RETURNING id"
                        " ), marque_id AS ("
                        "  SELECT id FROM marque"
                        "  UNION ALL SELECT id FROM marques WHERE name = "
                        f"{sql_literal(marque_name)} LIMIT 1"
                        " ), modele AS ("
                        "  SELECT id FROM modeles WHERE marque_id = (SELECT id FROM marque_id LIMIT 1) AND name = "
                        f"{modele_name_lit} LIMIT 1"
                        " ), ins_modele AS ("
                        "  INSERT INTO modeles(marque_id, name)"
                        "  SELECT (SELECT id FROM marque_id LIMIT 1), "
                        f"{modele_name_lit}"
                        "  WHERE "
                        f"{should_insert_modele}"
                        "  RETURNING id"
                        " ), modele_id AS ("
                        "  SELECT id FROM ins_modele"
                        "  UNION ALL SELECT id FROM modele"
                        " )"
                        " INSERT INTO lot_items (lot_id, serial_number, type, marque_id, modele_id, entry_type, entry_date, entry_time, state, technician, created_at, updated_at)"
                        f" SELECT {lot_id_expr}, "
                        f"{sql_literal(sn)}, {sql_literal(type_v)}, "
                        "(SELECT id FROM marque_id LIMIT 1), "
                        f"{modele_id_expr}, "
                        "'manual', "
                        f"{sql_date(entry_date)}::date, "
                        f"{sql_literal(entry_time)}::time, "
                        f"{sql_literal(state_v)}, {sql_literal(tech)}, NOW(), NOW()"
                        f"{lot_from};"
                    )
                    if idx == 0:
                        # Un seul WITH : ins_lot puis marque (pas deux WITH consécutifs)
                        rest = marque_chain[4:].lstrip()  # enlève "WITH"
                        lines.append(ins_lot_cte + ",\n" + rest)
                    else:
                        lines.append(marque_chain)
                else:
                    if idx == 0:
                        lines.append(
                            ins_lot_cte
                            + "\nINSERT INTO lot_items (lot_id, serial_number, type, marque_id, modele_id, entry_type, entry_date, entry_time, state, technician, created_at, updated_at)"
                            " SELECT ins_lot.id, "
                            f"{sql_literal(sn)}, {sql_literal(type_v)}, NULL, NULL, 'manual', {sql_date(entry_date)}::date, {sql_literal(entry_time)}::time, {sql_literal(state_v)}, {sql_literal(tech)}, NOW(), NOW()"
                            " FROM ins_lot;"
                        )
                    else:
                        lines.append(
                            "INSERT INTO lot_items (lot_id, serial_number, type, marque_id, modele_id, entry_type, entry_date, entry_time, state, technician, created_at, updated_at)"
                            f" SELECT {lot_id_sub}, "
                            f"{sql_literal(sn)}, {sql_literal(type_v)}, NULL, NULL, 'manual', {sql_date(entry_date)}::date, {sql_literal(entry_time)}::time, {sql_literal(state_v)}, {sql_literal(tech)}, NOW(), NOW();"
                        )
        else:
            lines.append(
                "INSERT INTO lots (user_id, name, status, item_count, description, received_at, finished_at, recovered_at, pdf_path, created_at, updated_at) VALUES "
                f"(NULL, {sql_literal(r.name)}, 'received', 0, NULL, {sql_literal(r.date)}::date, NULL, NULL, {sql_literal(r.pdf_path)}, NOW(), NOW());"
            )
    lines.append("")

    # Disques sessions
    lines.append("-- Lots disques (sessions)")
    for r in sorted(disques, key=lambda x: (x.date, x.name)):
        if r.disks:
            sess_id_sub = (
                f"(SELECT id FROM disques_sessions WHERE pdf_path = {sql_literal(r.pdf_path)} ORDER BY id DESC LIMIT 1)"
            )
            ins_sess_cte = (
                "WITH ins_sess AS ("
                " INSERT INTO disques_sessions (date, name, pdf_path, created_at)"
                f" VALUES ({sql_date(r.date)}, {sql_literal(r.name)}, {sql_literal(r.pdf_path)}, NOW())"
                " RETURNING id"
                ")"
            )
            for idx, dsk in enumerate(r.disks):
                sid = "ins_sess.id" if idx == 0 else sess_id_sub
                disk_from = " FROM ins_sess" if idx == 0 else ""
                if idx == 0:
                    lines.append(
                        ins_sess_cte
                        + "\nINSERT INTO disques_session_disks (session_id, serial, marque, modele, size, disk_type, interface, shred, created_at)"
                        f" SELECT {sid}, "
                        f"{sql_literal(dsk.get('serial'))}, {sql_literal(dsk.get('marque'))}, {sql_literal(dsk.get('modele'))}, {sql_literal(dsk.get('size'))}, "
                        f"{sql_literal(dsk.get('disk_type'))}, {sql_literal(dsk.get('interface'))}, {sql_literal(dsk.get('shred'))}, NOW()"
                        f"{disk_from};"
                    )
                else:
                    lines.append(
                        "INSERT INTO disques_session_disks (session_id, serial, marque, modele, size, disk_type, interface, shred, created_at)"
                        f" SELECT {sid}, "
                        f"{sql_literal(dsk.get('serial'))}, {sql_literal(dsk.get('marque'))}, {sql_literal(dsk.get('modele'))}, {sql_literal(dsk.get('size'))}, "
                        f"{sql_literal(dsk.get('disk_type'))}, {sql_literal(dsk.get('interface'))}, {sql_literal(dsk.get('shred'))}, NOW()"
                        f"{disk_from};"
                    )
        else:
            lines.append(
                "INSERT INTO disques_sessions (date, name, pdf_path, created_at) VALUES "
                f"({sql_date(r.date)}, {sql_literal(r.name)}, {sql_literal(r.pdf_path)}, NOW());"
            )
    lines.append("")

    # Dons
    lines.append("-- Dons")
    for r in sorted(dons, key=lambda x: (x.date, x.lot_name)):
        lines_json = json.dumps(r.lines or [], ensure_ascii=False)
        lines.append(
            "INSERT INTO dons (user_id, lot_name, date, pdf_path, lines, created_at) VALUES "
            f"(NULL, {sql_literal(r.lot_name)}, {sql_date(r.date)}, {sql_literal(r.pdf_path)}, {sql_literal(lines_json)}::jsonb, NOW());"
        )
    lines.append("")

    # Prêts matériel
    lines.append("-- Prêts matériel")
    for r in sorted(prets, key=lambda x: (x.date, x.borrower_name)):
        lines.append(
            "INSERT INTO prets_materiel (user_id, reference, borrower_type, borrower_name, borrower_contact, date, date_debut, date_fin, remuneration_gratuit, remuneration_montant, pdf_path, lines, created_at, updated_at) VALUES "
            f"(NULL, {sql_literal(r.reference)}, 'personne', {sql_literal(r.borrower_name)}, NULL, {sql_date(r.date)}, {sql_date(r.date)}, {sql_date(r.date)}, true, NULL, {sql_literal(r.pdf_path)}, {sql_literal(r.lines_json)}::jsonb, NOW(), NOW());"
        )
    lines.append("")

    lines.append("COMMIT;")
    lines.append("")
    lines.append("-- Fin import.sql")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Génère un import.sql depuis les PDFs /mnt/team/#TEAM/…")
    ap.add_argument("--team-root", default="/mnt/team/#TEAM", help="Racine TEAM (défaut: /mnt/team/#TEAM)")
    ap.add_argument("--out", default="import.sql", help="Chemin du fichier SQL de sortie")
    ap.add_argument("--wipe", action="store_true", help="TRUNCATE des tables avant import (dangereux)")
    ap.add_argument("--debug", action="store_true", help="Affiche les dossiers détectés + un échantillon de PDFs")
    ap.add_argument("--parse-prets-pdf", action="store_true", help="Extrait les lignes des prêts depuis le contenu PDF (via pdftotext)")
    ap.add_argument("--parse-commandes-pdf", action="store_true", help="Parse les tableaux des commandes (via pdftotext)")
    ap.add_argument("--parse-lots-pdf", action="store_true", help="Parse les tableaux des lots + insère lot_items (via pdftotext)")
    ap.add_argument("--parse-disques-pdf", action="store_true", help="Parse les tableaux des disques + insère disques_session_disks (via pdftotext)")
    ap.add_argument("--parse-dons-pdf", action="store_true", help="Parse les tableaux des dons (via pdftotext)")
    ap.add_argument("--parse-all-pdf", action="store_true", help="Active tous les parseurs PDF (commandes/lots/disques/dons/prêts)")
    args = ap.parse_args()

    team = Path(args.team_root)
    commandes_root = pick_existing_dir(team, ["#COMMANDES", "COMMANDES", "#Commandes", "Commandes"])
    if commandes_root is None:
        print(f"WARN Dossier commandes introuvable sous: {team}")
        commandes_root = team / "#COMMANDES"

    # Certains systèmes n'aiment pas les accents dans les noms de dossiers: on tente plusieurs variantes.
    tracabilite_dir = pick_existing_dir(
        team,
        ["#TRAÇABILITÉ", "#TRACABILITÉ", "#TRACABILITE", "#TRAÇABILITE", "TRAÇABILITÉ", "TRACABILITE"],
    )
    if tracabilite_dir is None:
        print(f"WARN Dossier traçabilité introuvable sous: {team}")
        tracabilite_dir = team / "#TRAÇABILITÉ"

    disques_dir = pick_existing_dir(tracabilite_dir, ["Disques", "DISQUES"]) or find_dir_recursive(tracabilite_dir, ["Disques"])
    dons_dir = pick_existing_dir(tracabilite_dir, ["don_stagiaires", "dons_stagiaires", "Dons", "DONS"]) or find_dir_recursive(
        tracabilite_dir, ["don_stagiaires", "dons_stagiaires"]
    )
    prets_names = [
        "prets_materiel",
        "prets-materiel",
        "pret_materiel",
        "pret-materiel",
        "prêts_materiel",
        "prêts-materiel",
        "prêt_materiel",
        "prêt-materiel",
        "prets materiel",
        "prêts materiel",
        "pret materiel",
        "prêt materiel",
    ]
    prets_dir = pick_existing_dir(tracabilite_dir, prets_names) or find_dir_recursive(tracabilite_dir, prets_names)

    if disques_dir is None:
        print(f"WARN Dossier Disques introuvable sous: {tracabilite_dir}")
        disques_dir = tracabilite_dir / "Disques"
    if dons_dir is None:
        print(f"WARN Dossier Dons introuvable sous: {tracabilite_dir}")
        dons_dir = tracabilite_dir / "don_stagiaires"
    if prets_dir is None:
        print(f"WARN Dossier Prêts introuvable sous: {tracabilite_dir}")
        prets_dir = tracabilite_dir / "prets_materiel"

    # Si tu as spécifiquement /#COMMANDES/Chargeur, on le prend, sinon on scanne tout #COMMANDES.
    commandes_chargeur = pick_existing_dir(commandes_root, ["Chargeur", "CHARGEUR"])
    commandes_scan_root = commandes_chargeur or commandes_root
    commandes = build_commandes_rows(commandes_scan_root)
    lots = build_simple_rows(tracabilite_dir)
    # Exclure sous-dossiers qui ne sont pas des lots (Disques/don_stagiaires/prets_materiel) du scan lots
    # -> on filtre après coup par chemin
    lots = [
        r
        for r in lots
        if "/Disques/" not in r.pdf_path
        and "/disques/" not in r.pdf_path
        and "/don_stagiaires/" not in r.pdf_path
        and "/dons_stagiaires/" not in r.pdf_path
        and "/prets_materiel/" not in r.pdf_path
        and "/prets-materiel/" not in r.pdf_path
        and "/pret_materiel/" not in r.pdf_path
        and "/pret-materiel/" not in r.pdf_path
    ]

    disques = build_disques_rows(disques_dir)
    dons = build_dons_rows(dons_dir)

    parse_all = args.parse_all_pdf
    commandes, lots, disques, dons = build_rows_with_pdf_parse(
        commandes=commandes,
        lots=lots,
        disques=disques,
        dons=dons,
        parse_commandes=parse_all or args.parse_commandes_pdf,
        parse_lots=parse_all or args.parse_lots_pdf,
        parse_disques=parse_all or args.parse_disques_pdf,
        parse_dons=parse_all or args.parse_dons_pdf,
    )

    prets = build_prets_rows_with_pdf_parse(prets_dir) if (parse_all or args.parse_prets_pdf) else build_prets_rows(prets_dir)

    if args.debug:
        print("")
        print("DEBUG Dossiers utilisés:")
        print("- team:", team)
        print("- commandes_root:", commandes_root)
        print("- commandes_scan_root:", commandes_scan_root)
        print("- tracabilite_dir:", tracabilite_dir)
        print("- disques_dir:", disques_dir)
        print("- dons_dir:", dons_dir)
        print("- prets_dir:", prets_dir)
        print("")
        if prets_dir and Path(prets_dir).exists():
            sample = list(iter_pdfs(Path(prets_dir)))[:5]
            print(f"DEBUG sample PDFs prets ({len(sample)}):")
            for p in sample:
                print("-", p)
            if not sample:
                # aide: affiche 10 sous-dossiers pour voir le nom exact
                try:
                    subs = [p for p in Path(prets_dir).iterdir() if p.is_dir()][:10]
                    print("DEBUG prets_dir sous-dossiers (10 max):")
                    for s in subs:
                        print("-", s.name)
                except Exception as e:
                    print("DEBUG listing prets_dir failed:", str(e))

    sql = emit_sql(commandes, lots, disques, dons, prets, wipe=args.wipe)
    out_path = Path(args.out)
    out_path.write_text(sql, encoding="utf-8")

    print("OK import SQL généré:", str(out_path))
    print(f"- Commandes: {len(commandes)}")
    print(f"- Lots: {len(lots)}")
    print(f"- Disques sessions: {len(disques)}")
    print(f"- Dons: {len(dons)}")
    print(f"- Prêts matériel: {len(prets)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

