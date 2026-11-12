"""
Which residues were buried to begin with, and which stopped being buried.

WHY TOTAL SASA CANNOT ANSWER THIS
A cavity opening inside a protein might expose 2-5 nm^2. The protein's total
surface is 150-250 nm^2 and fluctuates by several nm^2 from thermal motion
alone, so the new surface is well inside the noise of the old one. Watching the
total is watching the wrong number: it is dominated by residues that were
already exposed and stay exposed.

The fix is to stop measuring them. Classify every residue from a REFERENCE
WINDOW at the start of the run, keep only the ones that were buried there, and
report the area of just that set over time. A flat line means nothing opened; a
rise means something did, and the per-residue breakdown says what.

RELATIVE ACCESSIBILITY, NOT RAW AREA
"Buried" has to be judged per residue type. A fully exposed glycine has less
surface than a half-buried tryptophan, so a single area cutoff would call small
residues buried and large ones exposed regardless of their actual environment.
The standard measure is RELATIVE solvent accessibility — the residue's area
divided by the area that residue type has when fully exposed — with 20% the
conventional cut between buried and exposed.

Maximum accessible areas are the theoretical values of Tien et al. (2013),
PLoS ONE 8:e80635, which is the set most current work cites. Stated here so the
threshold can be reported in a methods section rather than being a magic number.

A REFERENCE WINDOW, NOT A FRAME
Burial is judged on an average over a window, not on frame 0. A single frame's
side-chain happens to be wherever it was at that instant, and classifying from
it makes a few percent of residues flip category for no physical reason.
"""
from __future__ import annotations

# Tien et al. (2013) theoretical maximum accessible surface area, nm^2.
# (Published in A^2; divided by 100 here because this app works in nm^2.)
MAX_ASA_NM2 = {
    "ALA": 1.29, "ARG": 2.74, "ASN": 1.95, "ASP": 1.93, "CYS": 1.67,
    "GLU": 2.23, "GLN": 2.25, "GLY": 1.04, "HIS": 2.24, "ILE": 1.97,
    "LEU": 2.01, "LYS": 2.36, "MET": 2.24, "PHE": 2.40, "PRO": 1.59,
    "SER": 1.55, "THR": 1.72, "TRP": 2.85, "TYR": 2.63, "VAL": 1.74,
}

# Protonation- and force-field-specific names that mean the same residue.
_ALIASES = {
    "HIE": "HIS", "HID": "HIS", "HIP": "HIS", "HSD": "HIS", "HSE": "HIS",
    "HSP": "HIS", "CYX": "CYS", "CYM": "CYS", "CYP": "CYS",
    "ASH": "ASP", "GLH": "GLU", "LYN": "LYS", "ARN": "ARG",
    "MSE": "MET",
}

# Anything not in the table — a ligand, a modified residue, a nucleotide — has
# no published maximum, so relative accessibility is undefined for it. Using a
# fallback would invent a denominator and silently classify it.
UNKNOWN_MAX = None


def max_asa(resname: str):
    """Maximum accessible area for a residue type, or None if not tabulated."""
    key = (resname or "").strip().upper()
    key = _ALIASES.get(key, key)
    return MAX_ASA_NM2.get(key, UNKNOWN_MAX)


def relative_accessibility(resname: str, area_nm2: float):
    """Area as a fraction of this residue type's maximum, or None."""
    m = max_asa(resname)
    if not m:
        return None
    return float(area_nm2) / m


def classify_buried(residues, reference_areas, rsa_threshold: float = 0.20):
    """
    Split residues into buried and exposed using a reference window's areas.

    residues:         [{"resnum": int, "resname": str}, ...]
    reference_areas:  mean area (nm^2) per residue over the reference window,
                      in the same order.

    Returns (buried, exposed, skipped) — each a list of dicts carrying the
    residue, its reference area and its reference RSA. `skipped` holds residues
    with no tabulated maximum; they are reported rather than dropped, because a
    ligand quietly missing from a "newly exposed" analysis is the kind of gap
    nobody notices.
    """
    buried, exposed, skipped = [], [], []
    for res, area in zip(residues, reference_areas):
        rsa = relative_accessibility(res.get("resname", ""), area)
        row = {**res, "ref_area": float(area), "ref_rsa": rsa}
        if rsa is None:
            skipped.append(row)
        elif rsa <= rsa_threshold:
            buried.append(row)
        else:
            exposed.append(row)
    return buried, exposed, skipped


def exposure_gain(buried, final_areas_by_resnum, min_gain_nm2: float = 0.10):
    """
    How much area each initially-buried residue gained, most first.

    `min_gain_nm2` is what counts as having genuinely emerged rather than
    jittered: side chains breathe, and without a floor every residue in the
    protein appears in the list with a gain of a few hundredths.
    """
    rows = []
    for res in buried:
        final = final_areas_by_resnum.get(res["resnum"])
        if final is None:
            continue
        gain = float(final) - res["ref_area"]
        rsa_final = relative_accessibility(res.get("resname", ""), final)
        rows.append({
            **res,
            "final_area": float(final),
            "final_rsa": rsa_final,
            "gain": gain,
            "emerged": gain >= min_gain_nm2,
        })
    rows.sort(key=lambda r: r["gain"], reverse=True)
    return rows
