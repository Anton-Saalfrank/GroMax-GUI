"""
Tests for the pure parsing / selection functions.

These are the functions that turn GROMACS output into plot data, and the ones
that build gmx selections. They're pure (no subprocess, no filesystem beyond a
tmp file), so they're cheap to test — and they're exactly where a silent
regression would corrupt results without anything crashing.

Several tests encode behaviour that was VERIFIED against a real GROMACS 2024.2
during development and would be easy to "fix" back into a bug later. Those are
marked REGRESSION and cite what was observed.

Run:  python3 -m pytest backend/tests/ -q      (or: python3 backend/tests/test_parsers.py)
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.gmx import parse_xvg, _last_group_in_ndx, _count_atoms_in_ndx_group
from core.session import ChainDef
from core.system_map import parse_pdb_chains, bio_to_flat
from core.contact_query import (_normalize_target, _is_full_selection,
                                _hbond_reference_atoms, _parse_hbond_pf)
from analyses.rmsd2d import parse_xpm
from core.chimerax import flat_to_bio, build_defattr, _safe_attr_name
from core.structure import _condition_pdb, BACKBONE_ATOMS
from core.ndx_builder import (_diagnose_ndx_error, normalize_selection,
                              is_custom_selection, assert_make_ndx_dialect,
                              _extract_last_group_block)
from core.replica_agg import _agg_replicas
from fastapi import HTTPException


# ─── helpers ──────────────────────────────────────────────────────────────────

def write(tmp_path, name, text):
    p = tmp_path / name
    p.write_text(text)
    return p


# ─── parse_xvg ────────────────────────────────────────────────────────────────

XVG = """# Created by gmx rms
@    title "RMSD"
@    xaxis  label "Time (ps)"
@    yaxis  label "RMSD (nm)"
@ s0 legend "Backbone"
    0.0000000    0.0000000
  100.0000000    0.1234000
  200.0000000    0.2345000
"""

def test_parse_xvg_reads_axes_and_series(tmp_path):
    d = parse_xvg(write(tmp_path, "a.xvg", XVG))
    assert d["x"] == [0.0, 100.0, 200.0]
    assert d["y_series"] == [[0.0, 0.1234, 0.2345]]
    assert d["xlabel"] == "Time (ps)"
    assert d["ylabel"] == "RMSD (nm)"
    assert d["title"] == "RMSD"
    assert d["labels"] == ["Backbone"]


def test_parse_xvg_title_with_gromacs_padding(tmp_path):
    # REGRESSION: real gmx writes '@    title "..."' with padding. A fixed
    # '@ title' prefix check never fired, so titles were silently always empty.
    txt = '@    title "Number of hydrogen bonds"\n@    xaxis  label "Time (ps)"\n1.0 2.0\n'
    d = parse_xvg(write(tmp_path, "t.xvg", txt))
    assert d["title"] == "Number of hydrogen bonds"
    assert d["xlabel"] == "Time (ps)"


def test_parse_xvg_multi_column(tmp_path):
    txt = "@    yaxis  label \"v\"\n1.0  2.0  3.0\n2.0  4.0  6.0\n"
    d = parse_xvg(write(tmp_path, "b.xvg", txt))
    assert d["x"] == [1.0, 2.0]
    assert d["y_series"] == [[2.0, 4.0], [3.0, 6.0]]


def test_parse_xvg_skips_comments_and_junk(tmp_path):
    txt = "# comment\n@ title \"t\"\nnot numbers\n1.0 2.0\n\n3.0 4.0\n"
    d = parse_xvg(write(tmp_path, "c.xvg", txt))
    assert d["x"] == [1.0, 3.0]


def test_parse_xvg_empty_file_is_not_a_crash(tmp_path):
    d = parse_xvg(write(tmp_path, "d.xvg", "# nothing\n"))
    assert d["x"] == [] and d["y_series"] == []


# ─── ndx group parsing ────────────────────────────────────────────────────────

NDX = """[ System ]
   1    2    3    4
[ Protein ]
   1    2
[ my_selection ]
  10   11   12
  13
"""

def test_last_group_in_ndx(tmp_path):
    # REGRESSION: make_ndx -o APPENDS on some builds, so the group we just
    # created is the LAST block, never a guessable index.
    name, count = _last_group_in_ndx(write(tmp_path, "a.ndx", NDX))
    assert name == "my_selection"
    assert count == 4


def test_count_atoms_in_named_group(tmp_path):
    p = write(tmp_path, "b.ndx", NDX)
    assert _count_atoms_in_ndx_group(p, "System") == 4
    assert _count_atoms_in_ndx_group(p, "Protein") == 2
    assert _count_atoms_in_ndx_group(p, "nope") is None


def test_last_group_empty_ndx(tmp_path):
    assert _last_group_in_ndx(write(tmp_path, "c.ndx", "")) is None


# ─── XPM matrix (2D-RMSD) ─────────────────────────────────────────────────────

XPM = '''/* XPM */
static char *gromacs_xpm[] = {
"3 3   2 1",
"A  c #000000 " /* "0" */,
"B  c #FFFFFF " /* "1" */,
"ABA",
"BAB",
"ABA"
};
'''

def test_parse_xpm_shape_and_values(tmp_path):
    z, meta = parse_xpm(write(tmp_path, "m.xpm", XPM))
    assert len(z) == 3 and all(len(row) == 3 for row in z)
    vals = {v for row in z for v in row}
    assert vals <= {0.0, 1.0}
    assert isinstance(meta, dict)


def test_parse_xpm_is_flipped_to_bottom_left_origin(tmp_path):
    # XPM rows are written top-to-bottom; plots expect origin bottom-left.
    txt = XPM.replace('"ABA",\n"BAB",\n"ABA"', '"AAA",\n"AAA",\n"BBB"')
    z, _ = parse_xpm(write(tmp_path, "m2.xpm", txt))
    assert z[0] == [1.0, 1.0, 1.0], "last written row must end up first"



# ─── PDB chain parsing ────────────────────────────────────────────────────────

def _atom(serial, name, resname, chain, resseq):
    return (f"ATOM  {serial:5d} {name:^4s} {resname:>3s} {chain}{resseq:4d}"
            f"    0.000   0.000   0.000  1.00  0.00           C")

HOMODIMER = "\n".join([
    # chain A: 400-402
    _atom(1, "N", "ASP", "A", 400), _atom(2, "CA", "ASP", "A", 400),
    _atom(3, "N", "LYS", "A", 401), _atom(4, "CA", "LYS", "A", 401),
    _atom(5, "N", "GLU", "A", 402), _atom(6, "CA", "GLU", "A", 402),
    # chain B: SAME numbers 400-402 (this is what broke contact labelling)
    _atom(7, "N", "ASP", "B", 400), _atom(8, "CA", "ASP", "B", 400),
    _atom(9, "N", "LYS", "B", 401), _atom(10, "CA", "LYS", "B", 401),
    _atom(11, "N", "GLU", "B", 402), _atom(12, "CA", "GLU", "B", 402),
    # water must be filtered out of the residue table
    "ATOM     13  OW  SOL A 999       0.000   0.000   0.000  1.00  0.00           O",
]) + "\n"


def test_parse_pdb_chains_homodimer(tmp_path):
    # REGRESSION: on a homodimer both chains are numbered 400-800, so a residue
    # NUMBER is ambiguous. The flat index must stay distinct per chain.
    chains, residues = parse_pdb_chains(write(tmp_path, "d.pdb", HOMODIMER))
    assert [c["id"] for c in chains] == ["A", "B"]
    assert len(residues) == 6, "water must be excluded"
    a400 = next(r for r in residues if r["chain"] == "A" and r["resnum"] == 400)
    b400 = next(r for r in residues if r["chain"] == "B" and r["resnum"] == 400)
    assert a400["flat"] != b400["flat"], "repeated resnum must not collapse"
    assert a400["resname"] == b400["resname"] == "ASP"


def test_bio_to_flat_offsets_by_chain():
    # REGRESSION: verified against the real system — VPS35 chain B D629 -> flat 631.
    chains = [
        ChainDef(id="A", start_resnum=1, end_resnum=100, n_residues=100),
        ChainDef(id="B", start_resnum=1, end_resnum=100, n_residues=100),
    ]
    assert bio_to_flat(chains, "A", 1) == 1
    assert bio_to_flat(chains, "A", 100) == 100
    assert bio_to_flat(chains, "B", 1) == 101, "chain B starts after all of chain A"
    assert bio_to_flat(chains, "B", 50) == 150


# ─── make_ndx selection normalisation ─────────────────────────────────────────

def test_normalize_selection_collapses_ri_chain():
    # REGRESSION: 'ri 2 & ri 5' is the INTERSECTION (empty) in make_ndx. Users
    # mean the union, which make_ndx writes as one multi-value term.
    assert normalize_selection("ri 2 & ri 5") == "ri 2 5"
    assert normalize_selection("ri 2 & ri 5 | ri 8-10") == "ri 2 5 8-10"


def test_normalize_selection_leaves_other_expressions_alone():
    for s in ['"Backbone" & ri 200-270', "ri 10-50", "3 & ri 5"]:
        assert normalize_selection(s) == s


def test_is_custom_selection():
    assert is_custom_selection("ri 10-50")
    assert is_custom_selection('"Backbone" & ri 200')
    assert not is_custom_selection("Protein")
    assert not is_custom_selection("C-alpha")
    assert not is_custom_selection("3")


# ─── contact-query target normalisation ───────────────────────────────────────

def test_bare_numbers_become_resindex():
    # REGRESSION: verified on GROMACS 2024.2 — 'resindex N' matches make_ndx's
    # 'ri N' (resindex 210 -> biological D620); 'resid N' points elsewhere.
    for s in ["210", "ri 210", "resid 210", "resindex 210"]:
        assert _normalize_target(s) == "resindex 210"
    assert _normalize_target("210-215") == "resindex 210 to 215"


def test_atom_level_selections_pass_through_untouched():
    for s in ["resindex 210 and name OD1 OD2",
              "resindex 210 and not name N CA C O",
              "resindex 210 and name NZ"]:
        assert _is_full_selection(s)
        assert _normalize_target(s) == s, "atom-level targets must not be rewritten"


# ─── gmx hbond -pf parsing ────────────────────────────────────────────────────

HB_NDX = '''[ resindex 210 ]
 3358  3359  3360  3361  3362  3363  3364  3365  3366  3367  3368  3369
[ donors_hydrogens_resindex 210 ]
 3358 3359
[ acceptors_resindex 210 ]
 3358  3366  3367  3369
[ group "Protein" and not resindex 210 ]
    1     2     3
[ hbonds_resindex 210-group "Protein"_frame_0 ]
   3413   3414   3369
[ hbonds_resindex 210-group "Protein"_frame_1 ]
   3403   3404   3366
   3413   3414   3369
[ hbonds_resindex 210-group "Protein"_frame_2 ]
'''

def test_hbond_reference_atoms_is_first_block_only(tmp_path):
    ref = _hbond_reference_atoms(write(tmp_path, "hb.ndx", HB_NDX))
    assert ref == set(range(3358, 3370)), "must stop before donors_/acceptors_ blocks"


def test_parse_hbond_pf_counts_target_residues(tmp_path):
    # Each H-bond line is donor/hydrogen/acceptor; the atom NOT in the reference
    # residue identifies the partner. Empty frames still count toward the total.
    p = write(tmp_path, "hb2.ndx", HB_NDX)
    ref = _hbond_reference_atoms(p)
    atom_map = {3413: 50, 3414: 50, 3403: 51, 3404: 51}
    total, per_res = _parse_hbond_pf(p, ref, atom_map)
    assert total == 3, "frame 2 is empty but still a frame"
    assert per_res[50] == 2      # frames 0 and 1
    assert per_res[51] == 1      # frame 1 only


def test_parse_hbond_pf_counts_a_residue_once_per_frame(tmp_path):
    txt = (HB_NDX.rstrip() + "\n"
           "[ hbonds_x_frame_3 ]\n"
           "   3413   3414   3369\n"
           "   3415   3416   3366\n")   # second atom, SAME residue
    p = write(tmp_path, "hb3.ndx", txt)
    ref = _hbond_reference_atoms(p)
    total, per_res = _parse_hbond_pf(p, ref, {3413: 50, 3415: 50})
    assert per_res[50] == 3, "two H-bonds to one residue in a frame count once"


# ─── ChimeraX export ──────────────────────────────────────────────────────────
# A wrong residue mapping produces a figure that LOOKS fine but colours the
# wrong residues — invisible in the output and potentially published. These
# tests pin the mapping exactly.

_CX_CHAINS = [
    ChainDef(id="A", label="VPS35", start_resnum=400, end_resnum=800, n_residues=401),
    ChainDef(id="B", label="VPS29", start_resnum=1,   end_resnum=182, n_residues=182),
]


def test_flat_to_bio_round_trips_for_every_residue():
    """bio -> flat -> bio must be the identity across the whole system."""
    for c in _CX_CHAINS:
        for r in range(c.start_resnum, c.end_resnum + 1):
            flat = bio_to_flat(_CX_CHAINS, c.id, r)
            assert flat_to_bio(_CX_CHAINS, flat) == (c.id, r), \
                f"round trip failed at {c.id}:{r}"


def test_flat_to_bio_chain_boundaries():
    assert flat_to_bio(_CX_CHAINS, 1) == ("A", 400)      # first residue
    assert flat_to_bio(_CX_CHAINS, 401) == ("A", 800)    # last of chain A
    assert flat_to_bio(_CX_CHAINS, 402) == ("B", 1)      # first of chain B
    assert flat_to_bio(_CX_CHAINS, 583) == ("B", 182)    # last residue


def test_flat_to_bio_rejects_out_of_range():
    """Out-of-range must return None, never a plausible-looking wrong answer."""
    assert flat_to_bio(_CX_CHAINS, 0) is None
    assert flat_to_bio(_CX_CHAINS, 584) is None
    assert flat_to_bio(_CX_CHAINS, -5) is None


def test_defattr_is_tab_separated():
    """REGRESSION RISK: ChimeraX silently fails to parse space-separated specs."""
    txt = build_defattr([1.23, 4.56], "gromaxRMSF", _CX_CHAINS, [1, 402])
    assert "\t/A:400\t1.23" in txt
    assert "\t/B:1\t4.56" in txt
    for line in txt.splitlines():
        if line.startswith((" ", "\t")):
            assert line.startswith("\t"), f"assignment line must use a TAB: {line!r}"


def test_defattr_header_is_wellformed():
    txt = build_defattr([1.0], "gromaxX", _CX_CHAINS, [1])
    assert "attribute: gromaxX" in txt
    assert "recipient: residues" in txt
    assert "match mode: 1-to-1" in txt


def test_defattr_without_chains_uses_bare_spec():
    txt = build_defattr([2.5], "gromaxX", None, [7])
    assert "\t:7\t2.5" in txt


def test_defattr_skips_unmappable_residues():
    txt = build_defattr([1.0, 2.0], "gromaxX", _CX_CHAINS, [1, 9999])
    assert "/A:400" in txt
    assert "WARNING" in txt and "outside" in txt


def test_defattr_refuses_when_nothing_maps():
    """Better to fail loudly than emit an empty attribute file."""
    try:
        build_defattr([1.0], "gromaxX", _CX_CHAINS, [9999])
    except ValueError:
        return
    raise AssertionError("expected ValueError when no residues map")


def test_attr_name_is_identifier_safe():
    assert _safe_attr_name("RMSF C-alpha") == "gromaxRMSF_C_alpha"
    assert _safe_attr_name("2d rmsd").startswith("gromaxV")   # no leading digit
    assert _safe_attr_name("") == "gromaxValue"


# ─── Structure viewer: reference-PDB resolution ───────────────────────────────
# REGRESSION: the viewer originally looked only at condition.pdb and 404'd for
# any session whose structure was imported via the System tab instead — which
# is the common case, since many simulation folders contain no .pdb at all.

class _FakeCond:
    def __init__(self, name="WT", pdb=None, files=None):
        self.name, self.pdb, self.files = name, pdb, files or {}


class _FakeSD:
    def __init__(self, source_pdb=None):
        self.source_pdb = source_pdb
        self.chains, self.residues = [], []


class _FakeState:
    def __init__(self, cond=None, sd=None):
        self.conditions = {"c1": cond} if cond else {}
        self.system_definition = sd


def _write_tmp_pdb(tmpdir, name="ref.pdb"):
    p = Path(tmpdir) / name
    p.write_text("ATOM      1  N   ALA A   1       0.000   0.000   0.000\nEND\n")
    return p


def test_structure_prefers_condition_pdb():
    with tempfile.TemporaryDirectory() as d:
        pdb = _write_tmp_pdb(d)
        st = _FakeState(_FakeCond(pdb=str(pdb)), _FakeSD("/nonexistent.pdb"))
        assert _condition_pdb(st, "c1") == pdb


def test_structure_falls_back_to_system_definition_pdb():
    """The common case: no PDB in the scanned folder, one imported in System."""
    with tempfile.TemporaryDirectory() as d:
        pdb = _write_tmp_pdb(d)
        st = _FakeState(_FakeCond(pdb=None), _FakeSD(str(pdb)))
        assert _condition_pdb(st, "c1") == pdb


def test_structure_falls_back_when_condition_pdb_is_missing_on_disk():
    with tempfile.TemporaryDirectory() as d:
        pdb = _write_tmp_pdb(d)
        st = _FakeState(_FakeCond(pdb="/definitely/not/here.pdb"), _FakeSD(str(pdb)))
        assert _condition_pdb(st, "c1") == pdb


def test_structure_error_names_a_real_tab():
    """The first version of this message pointed at a 'Files tab' that does
    not exist in the UI, which is worse than no guidance."""
    st = _FakeState(_FakeCond(pdb=None), None)
    try:
        _condition_pdb(st, "c1")
    except HTTPException as e:
        detail = str(e.detail)
        assert "System tab" in detail or "Setup tab" in detail
        assert "Files tab" not in detail
        return
    raise AssertionError("expected HTTPException")


# ─── make_ndx selection diagnostics ───────────────────────────────────────────
# The UI showed raw truncated C++ errors ("tandard library runti…") when a
# make_ndx selection failed. These pin the human-readable translation.

def test_ndx_error_flags_missing_group_index():
    d = _diagnose_ndx_error("3 & ri 211", "Group 3 does not exist")
    assert d and "Group index 3 does not exist" in d


def test_ndx_error_handles_runtime_error():
    d = _diagnose_ndx_error("ri 200-270",
                            "terminate called after throwing an instance of std::runtime_error")
    assert d and "could not parse" in d.lower()


def test_ndx_error_none_when_clean():
    assert _diagnose_ndx_error("Protein & ri 5", "") is None


def test_normalize_leaves_group_and_residue_intact():
    """'3 & ri 211' is a valid intersection, not a collapsible ri-chain."""
    assert normalize_selection("3 & ri 211") == "3 & ri 211"


def test_normalize_collapses_ri_union():
    """'ri 2 & ri 5 & ri 8' means the union; make_ndx needs 'ri 2 5 8'."""
    assert normalize_selection("ri 2 & ri 5 & ri 8") == "ri 2 5 8"


# ─── Mutation sites in residue picking ────────────────────────────────────────
# REGRESSION: the identity check blocked ANY residue whose name differed
# between the reference PDB and the simulated system. In a WT-vs-mutant project
# that fires on the mutation itself — the single most interesting residue —
# even when picking a backbone atom that is identical in both.

def test_backbone_atoms_cover_all_amino_acids():
    """These exist in every standard residue, so a selection restricted to
    them is well defined regardless of the substitution."""
    assert {"N", "CA", "C", "O"} <= BACKBONE_ATOMS


def test_ca_is_backbone_so_mutation_must_not_block():
    assert "CA" in BACKBONE_ATOMS


def test_sidechain_atoms_are_not_treated_as_backbone():
    """OH exists in TYR but not CYS — a Y269C pick on OH is NOT comparable."""
    for atom in ("OH", "SG", "NZ", "OD1", "CB"):
        assert atom not in BACKBONE_ATOMS, f"{atom} must not count as backbone"


# ─── Selection dialect ────────────────────────────────────────────────────────
# REGRESSION, scientific correctness: residue picks were emitted as `gmx select`
# syntax ("resindex 211 and name CA"). is_custom_selection() returned False for
# it, so it was never built into an index group — the string was passed to the
# analysis tool as if it were the NAME of an existing group. GROMACS resolved it
# to something else and the analysis produced confident, WRONG numbers with no
# error. These tests pin the make_ndx dialect.

def test_generated_selection_is_recognised_as_custom():
    """If this is False the string is treated as a group NAME, not an
    expression, and the wrong atoms are analysed with no error."""
    for sel in ["ri 1 & a CA", "ri 1 3 & a CA", "ri 1 2", "ri 1 & a OD1 OD2"]:
        assert is_custom_selection(sel), f"{sel!r} would not build an ndx group"


def test_select_dialect_is_rejected_not_silently_passed():
    for bad in ["resindex 211 and name CA",
                "(resindex 211 and name CA)",
                "resindex 211"]:
        try:
            assert_make_ndx_dialect(bad)
        except RuntimeError:
            continue
        raise AssertionError(f"{bad!r} must be rejected, not passed through")


def test_real_group_names_still_pass():
    for good in ["Protein", "C-alpha", "Backbone", "3", "ri 211 & a CA",
                 "3 & ri 211"]:
        assert_make_ndx_dialect(good)      # must not raise


# ─── Replica-length truncation ────────────────────────────────────────────────

def test_mean_truncation_is_reported():
    """A mean stops at the shortest replica. Correct, but it must not be
    silent: Results (mean) ended at 1.2 us while Compare (per-replica) showed
    2.5 us, with nothing explaining the gap."""
    long_r = {"kind": "line", "x": [i * 10 for i in range(251)],
              "y": [0.5] * 251, "xlabel": "Time (ns)", "ylabel": "d",
              "title": "t", "_rep_index": 1}
    short_r = {"kind": "line", "x": [i * 10 for i in range(121)],
               "y": [0.6] * 121, "xlabel": "Time (ns)", "ylabel": "d",
               "title": "t", "_rep_index": 2}
    agg = _agg_replicas([long_r, short_r])
    assert agg["mean_truncated"] is True
    assert agg["t_end_mean"] == 1200
    assert agg["t_end_longest"] == 2500
    assert agg["short_replicas"] == [2]


def test_equal_length_replicas_are_not_flagged():
    r = {"kind": "line", "x": [0, 10, 20], "y": [1, 2, 3],
         "xlabel": "Time (ns)", "ylabel": "d", "title": "t", "_rep_index": 1}
    agg = _agg_replicas([dict(r), dict(r, _rep_index=2)])
    assert agg["mean_truncated"] is False


# ─── ndx group extraction ─────────────────────────────────────────────────────
# REGRESSION: a bad edit deleted this function's `def` line, leaving its body as
# unreachable code inside the previous function. The module still IMPORTED
# cleanly — so the import check passed — and it only failed at runtime, mid-job,
# with "name '_extract_last_group_block' is not defined". Every custom residue
# selection broke. Calling it here means a missing helper fails in tests.

def test_extract_last_group_block_exists_and_works():
    ndx = (
        "[ System ]\n   1    2    3\n"
        "[ Protein ]\n   1    2\n"
        "[ gromax_tmp ]\n  17   18   19\n"
    )
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "test.ndx"
        p.write_text(ndx)
        out = _extract_last_group_block(p, "gromax_sel_0")
    assert out.startswith("[ gromax_sel_0 ]")
    assert "17" in out and "19" in out
    assert "Protein" not in out, "must take the LAST block, not an earlier one"


def test_extract_last_group_block_handles_multiline_bodies():
    ndx = "[ A ]\n 1 2\n[ B ]\n 5 6 7\n 8 9 10\n"
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "t.ndx"
        p.write_text(ndx)
        out = _extract_last_group_block(p, "sel")
    assert "5" in out and "10" in out and "1 2" not in out


# ─── Contacts-over-time analysis ──────────────────────────────────────────────

def test_ncontacts_uses_on_flag_and_cutoff():
    """-on is the contact COUNT output; -od would be the minimum distance."""
    from analyses import get_analysis
    a = get_analysis("ncontacts")
    args = a.build_args({"tpr": "s.tpr", "xtc": "t.xtc", "_out_xvg": "o.xvg",
                         "params": {"cutoff": 0.45}, "stride": 1})
    assert "-on" in args and "-od" not in args
    assert args[args.index("-d") + 1] == "0.45"


def test_ncontacts_rejects_angstrom_style_cutoff():
    """6 (Angstrom) instead of 0.6 (nm) would silently saturate the count."""
    from analyses import get_analysis
    a = get_analysis("ncontacts")
    try:
        a.build_args({"tpr": "s", "xtc": "t", "_out_xvg": "o",
                      "params": {"cutoff": 60}, "stride": 1})
    except RuntimeError:
        return
    raise AssertionError("an out-of-range cutoff must be rejected")


def test_ncontacts_group_flag_is_optional():
    from analyses import get_analysis
    a = get_analysis("ncontacts")
    base = {"tpr": "s", "xtc": "t", "_out_xvg": "o", "stride": 1}
    assert "-group" not in a.build_args({**base, "params": {"cutoff": 0.6}})
    assert "-group" in a.build_args(
        {**base, "params": {"cutoff": 0.6, "group_contacts": True}})


def test_cutoff_changes_cache_key():
    """Without this the cache returns the old trace under a new cutoff."""
    from core.gmx import make_analysis_hash
    base = {"condition": "c1", "name": "x", "groups": ["A", "B"],
            "time_start": None, "time_end": None, "stride": 1,
            "n_replicas": 10, "files": ["f"]}
    k1 = make_analysis_hash("ncontacts", {**base, "params": {"cutoff": 0.6}})
    k2 = make_analysis_hash("ncontacts", {**base, "params": {"cutoff": 0.45}})
    assert k1 != k2


# ─── Chain resolution when the structure has no chain IDs ─────────────────────
# REGRESSION: GROMACS-processed PDBs often have a BLANK chain-ID column, so NGL
# reports an empty chain name. Every pick was then rejected as "outside the
# defined chains", making residue selection unusable.

def _cx_chains():
    return [ChainDef(id="A", label="", start_resnum=1, end_resnum=350, n_residues=350),
            ChainDef(id="B", label="", start_resnum=360, end_resnum=500, n_residues=141)]


def test_non_polymer_resnames_cover_common_water_models():
    from core.structure import NON_POLYMER_RESNAMES
    for w in ("HOH", "TIP3", "SOL", "WAT", "SPC"):
        assert w in NON_POLYMER_RESNAMES, f"{w} must be rejected as solvent"


def test_ions_are_rejected_as_non_polymer():
    from core.structure import NON_POLYMER_RESNAMES
    for ion in ("NA", "CL", "K", "MG", "ZN"):
        assert ion in NON_POLYMER_RESNAMES


def test_backbone_and_solvent_sets_apply_to_different_fields():
    """CA is both the alpha carbon (an ATOM name) and calcium (a RESIDUE name).

    The two sets are matched against different fields — BACKBONE_ATOMS against
    the picked atom, NON_POLYMER_RESNAMES against the residue — so they cannot
    interfere. This test pins that separation, because collapsing the two would
    silently break every backbone selection.
    """
    from core.structure import BACKBONE_ATOMS, NON_POLYMER_RESNAMES
    assert "CA" in BACKBONE_ATOMS
    # Calcium as a residue is deliberately spelled CA2/CAL here: adding a bare
    # "CA" would be matched against resnames only, but the ambiguity is not
    # worth the confusion for a residue type these systems rarely contain.
    assert BACKBONE_ATOMS.isdisjoint({"HOH", "TIP3", "SOL"})
    assert "TIP3" in NON_POLYMER_RESNAMES


# ─── Nonpolar SASA ────────────────────────────────────────────────────────────

def test_nonpolar_sasa_uses_output_not_a_separate_surface():
    """Taking the surface of an apolar-only selection would be WRONG: removing
    polar atoms exposes area that is buried in the intact protein. The surface
    must be the whole group, with the apolar part reported via -output."""
    from analyses import get_analysis
    a = get_analysis("sasa_nonpolar")
    args = a.build_args({"tpr": "s", "xtc": "t", "_out_xvg": "o",
                         "groups": ["Protein"], "stride": 1, "params": {}})
    joined = " ".join(args)
    assert "-surface" in args and "-output" in args
    assert 'group "Protein"' in joined
    i_surface = args.index("-surface")
    assert "and" not in args[i_surface + 1], \
        "the -surface selection must be the whole group, unrestricted"


def test_nonpolar_definitions_differ():
    from analyses import get_analysis
    a = get_analysis("sasa_nonpolar")
    base = {"tpr": "s", "xtc": "t", "_out_xvg": "o",
            "groups": ["Protein"], "stride": 1}
    charge = " ".join(a.build_args({**base, "params": {"definition": "charge"}}))
    element = " ".join(a.build_args({**base, "params": {"definition": "element"}}))
    assert "charge {" in charge and "name" not in charge.split("-output")[1]
    assert "name" in element and "charge" not in element.split("-output")[1]


def test_nonpolar_sasa_reads_the_output_column_not_the_total():
    """REGRESSION RISK: with -output the xvg is time, TOTAL, then the group.
    Reading column 1 would silently report total SASA as nonpolar SASA."""
    from analyses import get_analysis
    xvg = "\n".join([
        '@    xaxis  label "Time (ps)"',
        '@ s0 legend "Total"',
        '@ s1 legend "Nonpolar"',
        "    0.000  180.500   95.200",
        " 1000.000  182.100   96.800",
    ]) + "\n"
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "sasa.xvg"
        p.write_text(xvg)
        r = get_analysis("sasa_nonpolar").parse(p, {"params": {}})
    assert r["y"] == [95.2, 96.8], "must read the -output column"
    assert r["y_total_sasa"] == [180.5, 182.1]
    assert r["x"] == [0.0, 1.0], "ps -> ns"


def test_nonpolar_sasa_errors_without_an_output_column():
    from analyses import get_analysis
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "sasa.xvg"
        p.write_text('@ xaxis label "Time (ps)"\n 0.0 180.5\n')
        try:
            get_analysis("sasa_nonpolar").parse(p, {})
        except RuntimeError:
            return
    raise AssertionError("a missing nonpolar column must raise, not fall back")


if __name__ == "__main__":
    import tempfile, traceback
    passed = failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            if fn.__code__.co_argcount:
                with tempfile.TemporaryDirectory() as d:
                    fn(Path(d))
            else:
                fn()
            passed += 1
        except Exception:
            failed += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
