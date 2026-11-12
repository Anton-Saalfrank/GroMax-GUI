"""
Turning a user's selection into a GROMACS index group.

Split out of analysis_runner, which had grown to 2152 lines and twelve HTTP
endpoints. This half of it never touches HTTP, the job queue or the session —
it is a text-processing problem with one subprocess call — so it belongs on its
own where it can be read and tested without the rest.

The hard part is not building the group; it is explaining the failure. gmx
make_ndx has no operator precedence, no parentheses, and reports a syntax error
on STDOUT rather than stderr, so a wrong selection used to surface as an empty
group with no reason attached. `_diagnose_ndx_error` exists for that.
"""
import logging
import re as _re
from pathlib import Path

from .chimerax import flat_to_bio

log = logging.getLogger("gromax.analysis")


# ─── Resolve index group names to selection stdin ─────────────────────────────
# For the vertical slice we map friendly names to their standard gmx group index
# by reading the tpr's default groups. gmx accepts group NAMES on stdin too,
# so we can just pipe the name — but names with hyphens (C-alpha) work as typed.

# make_ndx tokens that signal a *custom selection* rather than a plain group name
_CUSTOM_RE = _re.compile(r'(&|\||<|>|\bri\b|\br\b|\ba\b|\batomnr\b|\bsplitres\b|\bsplitat\b|\bchain\b)')

def normalize_selection(sel: str) -> str:
    """
    Rewrite common inefficient/incorrect selection patterns into fast forms.

    The big one: 'ri 2 & ri 5 & ri 8' is both WRONG (& is AND, so it's the
    intersection = empty) and SLOW (complex expression tree). Users almost
    always mean the UNION of those residues, which make_ndx expresses as a
    single multi-value term: 'ri 2 5 8'. We detect a chain of 'ri <nums>'
    joined by '&' or '|' and collapse it into one 'ri' list.
    """
    s = sel.strip()
    # Match chains like: ri 2 & ri 5 | ri 8-10 & ri 12
    # Only collapse when EVERY term is a bare 'ri <ranges>' (no atom-name etc.)
    parts = _re.split(r'\s*[&|]\s*', s)
    ri_values = []
    all_ri = True
    for p in parts:
        m = _re.fullmatch(r'ri\s+([\d\s\-]+)', p.strip())
        if m:
            ri_values.append(m.group(1).strip())
        else:
            all_ri = False
            break
    if all_ri and len(parts) > 1:
        combined = " ".join(ri_values)
        return f"ri {combined}"
    return s


def is_custom_selection(group: str) -> bool:
    """
    True if `group` is a make_ndx selection expression (e.g. '3 & ri 200-270',
    'ri 10-50') rather than a plain existing group name ('Protein', 'C-alpha')
    or a bare group index ('3').
    """
    g = group.strip()
    if not g or g.isdigit():
        return False
    return bool(_CUSTOM_RE.search(g))


# `gmx select` dialect keywords. These are NOT make_ndx syntax, and a string
# containing them is not a group name either — so if one reaches us it is a
# programming error somewhere upstream.
_SELECT_DIALECT_RE = _re.compile(
    r'\b(resindex|resnr|resname|atomname|same\s+residue\s+as|within|of)\b|'
    r'\bname\s+[A-Za-z]|\band\b|\bor\b|\bnot\b'
)


def assert_make_ndx_dialect(group: str) -> None:
    """
    Fail loudly if a selection is in the wrong dialect.

    This exists because of a real bug: residue picks were emitted as
    `gmx select` syntax ("resindex 211 and name CA"). is_custom_selection()
    returned False for it, so it was never built into an index group — it was
    passed to the analysis tool as if it were the NAME of an existing group.
    GROMACS resolved it to something else entirely and the analysis produced
    confident, wrong numbers with no error anywhere.

    A loud failure is vastly preferable to silently analysing the wrong atoms.
    """
    g = (group or "").strip()
    if not g or g.isdigit() or is_custom_selection(g):
        return
    if _SELECT_DIALECT_RE.search(g):
        raise RuntimeError(
            f"Selection '{g}' is in `gmx select` syntax, but selections here "
            f"are built with `gmx make_ndx`, which uses a different dialect "
            f"(ri/a/&/|). Written for make_ndx this would be something like "
            f"'ri 211 & a CA'. Refusing to run rather than silently analysing "
            f"the wrong atoms."
        )




def _group_names(ndx_path) -> list[str]:
    """Group names in an .ndx file, in order. [] if it is missing."""
    try:
        return [l.strip().strip("[]").strip()
                for l in Path(ndx_path).read_text().splitlines()
                if l.strip().startswith("[")]
    except OSError:
        return []


def describe_ri_selection(chains, selection: str) -> str:
    """
    Say which BIOLOGICAL residues an `ri` selection actually covers.

    `ri N` is the 1-based index of a residue in the TOPOLOGY, counted straight
    through every chain. For a single chain starting at residue 1 that happens
    to equal the residue number people use; for anything else it does not, and
    `ri 206` quietly means a different residue from the one on the screen. The
    analysis then runs correctly on residues nobody chose, which is invisible in
    the output and shows up only as results that "do not correlate with what I
    selected".

    Returns a human description, or "" when there is nothing to disambiguate.
    """
    if not chains:
        return ""
    spans = _re.findall(r"\bri\s+([\d\s\-]+)", selection)
    if not spans:
        return ""
    bits = []
    for span in spans:
        for tok in span.split():
            if "-" in tok:
                lo, _, hi = tok.partition("-")
                try:
                    a, b = int(lo), int(hi)
                except ValueError:
                    continue
                ba, bb = flat_to_bio(chains, a), flat_to_bio(chains, b)
                if ba and bb:
                    bits.append(f"ri {a}-{b} = {ba[0] or '?'} {ba[1]}"
                                f"–{bb[0] or '?'} {bb[1]}")
                else:
                    bits.append(f"ri {a}-{b} is outside the system definition")
            else:
                try:
                    v = int(tok)
                except ValueError:
                    continue
                bio = flat_to_bio(chains, v)
                bits.append(f"ri {v} = {bio[0] or '?'} {bio[1]}" if bio
                            else f"ri {v} is outside the system definition")
    return "; ".join(bits)


def _ndx_groups(ndx_path) -> list[tuple[str, list[int]]]:
    """Every group in an .ndx, IN ORDER, with its atom numbers.

    A list rather than a dict: make_ndx happily writes two groups with the same
    name, and the order is what maps a group to the number make_ndx gave it.
    """
    out: list[tuple[str, list[int]]] = []
    try:
        text = Path(ndx_path).read_text()
    except OSError:
        return out
    for line in text.splitlines():
        t = line.strip()
        if t.startswith("[") and t.endswith("]"):
            out.append((t[1:-1].strip(), []))
        elif t and out:
            out[-1][1].extend(int(x) for x in t.split())
    return out


def split_selection_parts(sel: str) -> list[str]:
    """
    A GROMACS selection written as several parts, separated by ';'.

    WHY THIS EXISTS: make_ndx has no operator precedence and no parentheses.
    Measured on gmx 2024.2:

        ri 161 & a CB HB1 | ri 162      ->  21 atoms   (as intended)
        ri 162 | ri 161 & a CB HB1      ->   4 atoms   (read as
                                                         (ri 162 | ri 161) & a CB HB1)
        (ri 162) | (ri 161 & a CB HB1)  ->  syntax error

    So "these atoms of this residue, plus those atoms of that one" — exactly
    what a selection made by clicking atoms in a structure viewer produces —
    cannot be written as one line at all: every later '& a ...' re-intersects
    everything before it. Atom numbers are no escape either, because they shift
    whenever a mutation changes a residue's size (GLY270 O is atom 4376 in a
    wild type and 4366 in its Tyr->Cys mutant).

    Each part becomes its own group; the parts are then joined with '|' by
    group number. OR is associative, so left-to-right evaluation cannot get
    that wrong.
    """
    return [p.strip() for p in str(sel or "").split(";") if p.strip()]


def _atom_name_probes(part: str) -> list[tuple[str, str]]:
    """
    [(atom_name, probe_expression)] for a part that names SEVERAL atoms.

    WHY: make_ndx reports one combined count for a whole name list, so a name
    that matches nothing inside that residue is invisible whenever a sibling
    matches. Measured on a real pair of topologies:

        ri 269 & a CB HB1 O SG   ->  "Found 1101 atoms with names CB HB1 O SG"

    In the wild type residue 269 is a tyrosine with no SG, so that part quietly
    yielded 3 atoms instead of 4 — and the same selection gave 53 atoms in the
    mutant against 52 in the wild type, with nothing said. Comparing two
    conditions over different atom sets is the silent kind of wrong.

    A per-name probe inside the same residue set catches it: 'a SG' alone finds
    5 atoms system-wide (other cysteines), but 'ri 269 & a SG' finds none, and
    make_ndx then writes no group at all.

    Only positive 'a'/'name' clauses with two or more names are probed. A
    single name that matches nothing already makes the whole term empty, which
    the "Found 0 atoms" rule catches; and a negated clause matching nothing is
    harmless (excluding nothing excludes nothing).
    """
    clauses = [c.strip() for c in part.split("&")]
    out: list[tuple[str, str]] = []
    for k, c in enumerate(clauses):
        m = _re.match(r"^(?:a|name)\s+(.+)$", c)
        if not m:
            continue
        names = m.group(1).split()
        if len(names) < 2:
            continue
        for nm in names:
            rest = list(clauses)
            rest[k] = f"a {nm}"
            out.append((nm, " & ".join(rest)))
    return out


async def build_ndx_for_selections(tpr: str, groups: list[str], work_dir: Path,
                                    log_cb=None) -> tuple[list[str], str | None]:
    """
    Resolve requested groups into (names_to_feed, ndx_path).
    Any custom selections are materialised as named groups in a combined .ndx,
    so the analysis can reference them by name with -n. Plain names/indices
    pass through unchanged and need no .ndx.

    Robust approach: build one .ndx per custom selection (reading the LAST group
    block, which is the one we just created — no index guessing), then merge all
    custom groups into a single combined ndx that also carries the standard
    groups so plain-name groups still resolve.
    """
    from .gmx import run_gmx, _last_group_in_ndx

    # Guard BEFORE anything runs: a wrong-dialect string here would otherwise
    # be treated as a plain group name and silently resolved to the wrong atoms.
    for g in groups:
        assert_make_ndx_dialect(g)

    custom_idx = [i for i, g in enumerate(groups) if is_custom_selection(g)]
    if not custom_idx:
        return groups, None

    work_dir.mkdir(parents=True, exist_ok=True)
    combined = work_dir / "custom.ndx"

    # Start from the full default ndx (so standard groups remain available).
    base = work_dir / "_base.ndx"
    await run_gmx(["make_ndx", "-f", tpr, "-o", str(base)],
                  stdin_input="q\n", timeout=120)
    combined_blocks = base.read_text() if base.exists() else ""
    # The baseline group NAMES are the ground truth for "did the selection add
    # anything". See the check below for why nothing else works.
    base_names = _group_names(base)

    resolved = list(groups)
    for n, i in enumerate(custom_idx):
        parts = [normalize_selection(p) for p in split_selection_parts(groups[i])]
        multi = len(parts) > 1
        # The first group make_ndx creates gets the next free number, which is
        # the size of the baseline list (groups are numbered from 0).
        first = len(base_names)
        union = " | ".join(str(first + k) for k in range(len(parts)))
        # Per-name probes run in the SAME make_ndx session, after the union,
        # so they cannot disturb the group numbers the union line refers to.
        probes: list[tuple[int, str, str]] = []
        for pi, part in enumerate(parts):
            for nm, expr in _atom_name_probes(part):
                probes.append((pi, nm, expr))
        commands = (parts + [union] if multi else list(parts)) \
            + [e for _, _, e in probes]
        sel = "; ".join(parts)                      # for messages
        stable = f"gromax_sel_{n}"
        tmp = work_dir / f"_sel_{n}.ndx"
        if tmp.exists():
            tmp.unlink()
        r = await run_gmx(["make_ndx", "-f", tpr, "-o", str(tmp)],
                          stdin_input="\n".join(commands) + "\nq\n", timeout=120)

        stderr = r.get("stderr", "") or ""

        # DID make_ndx ACTUALLY ADD A GROUP?
        #
        # This is decided from the FILE, never from the text on stderr. Measured
        # against gmx 2024.2: a good selection writes one more group than the
        # baseline and names it after the expression ("r_277-287"); a rejected
        # one writes the defaults and nothing else. make_ndx exits 0 in BOTH
        # cases, so the exit code says nothing either.
        #
        # The previous version decided by searching stderr for "error",
        # "cannot", "runtime" and so on, which was wrong in both directions. A
        # stray match in GROMACS' normal output rejected a selection that had
        # built perfectly — the "could not be built" failures. And when no word
        # matched but the selection HAD failed, the code went on to take the
        # LAST group in the file, which is then a default group such as
        # SideChain-H or Water. That silently ran the analysis on atoms nobody
        # chose, with nothing anywhere reporting a problem: results that do not
        # correspond to the residues requested.
        # make_ndx prints "Syntax error:" on STDOUT, not stderr, so both
        # streams have to be read — diagnosing from stderr alone missed the
        # single line that says what was wrong with the expression.
        combined_out = ((r.get("stdout", "") or "") + "\n" + stderr).strip()

        new_names = [n for n in _group_names(tmp) if n not in base_names]

        # EVERY ATOM NAME MUST HAVE MATCHED SOMETHING IN ITS OWN PART.
        # An empty intersection writes no group ("Group is empty"), so a
        # shortfall in probe groups means a name was silently dropped.
        if probes and tmp.exists():
            n_before = len(parts) + (1 if multi else 0)
            built_all = _ndx_groups(tmp)[first:]
            if len(built_all) - n_before < len(probes):
                missing = []
                for pi, nm, expr in probes:
                    probe_ndx = work_dir / f"_sel_{n}_probe.ndx"
                    if probe_ndx.exists():
                        probe_ndx.unlink()
                    await run_gmx(["make_ndx", "-f", tpr, "-o", str(probe_ndx)],
                                  stdin_input=f"{expr}\nq\n", timeout=120)
                    if len(_ndx_groups(probe_ndx)) <= first:
                        missing.append((parts[pi], nm))
                    if len(missing) >= 5:
                        break
                if missing:
                    raise RuntimeError(
                        "These atom names matched nothing in the part that "
                        "names them: "
                        + "; ".join(f"'{nm}' in '{pt}'" for pt, nm in missing[:5])
                        + ".\nGROMACS reports one combined count for a list of "
                          "atom names, so it does not flag this — the group "
                          "would simply have come out smaller than asked for. "
                          "A common cause is an atom that exists in one "
                          "condition but not the other, such as a cysteine SG "
                          "where the other structure has a tyrosine.")

        if multi and tmp.exists():
            # If ANY part failed, make_ndx skipped it, every later group number
            # shifted by one, and the union line joined the wrong groups — or a
            # default group. So the union is not trusted: it is checked against
            # the parts, from the file.
            built = _ndx_groups(tmp)[first:first + len(parts) + 1]
            part_groups = built[:len(parts)]
            final = built[len(parts)] if len(built) > len(parts) else None
            if len(built) != len(parts) + 1:
                bad = []
                for k, part in enumerate(parts):
                    probe = work_dir / f"_sel_{n}_part{k}.ndx"
                    await run_gmx(["make_ndx", "-f", tpr, "-o", str(probe)],
                                  stdin_input=f"{part}\nq\n", timeout=120)
                    if len(_ndx_groups(probe)) <= first:
                        bad.append(part)
                raise RuntimeError(
                    f"Part of a multi-part selection could not be built: "
                    + ("; ".join(f"'{b}'" for b in bad[:3]) if bad else
                       "make_ndx created fewer groups than there are parts")
                    + ". Each part between the ';' must be a valid selection "
                      "on its own — e.g. 'ri 161 & a CB HB1'.")
            want = set()
            for _, atoms in part_groups:
                want.update(atoms)
            if set(final[1]) != want:
                raise RuntimeError(
                    f"The parts of '{sel}' built, but joining them gave "
                    f"{len(final[1])} atoms where the parts hold {len(want)}. "
                    f"Refusing rather than running on the wrong atoms.")

        if not tmp.exists() or not new_names:
            detail = (_diagnose_ndx_error(sel, combined_out, base_names)
                      or "make_ndx added no group for it, so it was rejected.")
            raise RuntimeError(
                f"Selection '{sel}' could not be built. {detail}\n"
                f"(GROMACS output: {combined_out[-300:] or '(none)'})")

        # DID EVERY TERM MATCH SOMETHING?
        #
        # make_ndx does not fail when part of a selection matches nothing — it
        # DROPS that term and keeps the rest. Measured: 'ri 1-5 & a ZZZ' prints
        # "Found 0 atoms with name ZZZ", then writes a group called "r_1-5"
        # holding all 20 atoms of residues 1-5. The user asked for an
        # intersection and silently received one of its operands, which is more
        # atoms than requested and no error anywhere.
        #
        # gmx states this itself, so no inference is needed: any "Found 0 atoms"
        # line means a term selected nothing.
        #
        # BUT ONLY A POSITIVE TERM IS DANGEROUS. The harm is that the group ends
        # up BIGGER than asked for, and that only happens when the dropped term
        # was there to narrow the selection:
        #     'ri 1-5 & a ZZZ'   -> 20 atoms instead of an intersection   REFUSE
        #     'ri 2-4 & ! a H*'  -> excluding nothing from ri 2-4, which IS
        #                           ri 2-4, on a structure with no hydrogens  OK
        # Refusing the second would reject the documented way to leave
        # hydrogens out of a contact count, on exactly the structures where
        # there is nothing to leave out.
        empty_terms = _re.findall(r"Found\s+0\s+atoms\s+with\s+([^\n]+)",
                                  combined_out)
        clauses = _re.split(r"[&|;\n]", sel)
        dangerous = []
        for t in empty_terms:
            parts = t.strip().split()
            token = parts[-1] if parts else ""
            negated = bool(token) and any(
                c.strip().startswith("!") for c in clauses if token in c)
            if not negated:
                dangerous.append(t)
        if dangerous:
            raise RuntimeError(
                f"Part of the selection '{sel}' matched nothing: "
                + "; ".join(f"no atoms with {t.strip()}" for t in dangerous[:3])
                + ".\nGROMACS does not fail on this — it drops that term and "
                  "keeps the rest, so the group would have contained MORE atoms "
                  "than you asked for. Check the atom or residue names "
                  "(case-sensitive: 'a CA', not 'a ca').")

        # The group we actually built: the union when there are several parts,
        # otherwise the single part. NOT the last group in the file — probe
        # groups come after it.
        target = first + len(parts) if multi else first
        all_groups = _ndx_groups(tmp)
        last = ((all_groups[target][0], len(all_groups[target][1]))
                if target < len(all_groups) else None)
        if last is None or last[1] == 0:
            raise RuntimeError(
                f"Selection '{sel}' matched 0 atoms. If you used a group index "
                f"like '3', check it exists for THIS system (indices differ "
                f"between systems); 'ri N' uses the 1-based topology residue "
                f"index, which for a multi-chain system is NOT the biological "
                f"residue number — pick the residue in the Structure tab to get "
                f"the right index.")
        # Extract the last group block and append it under the stable name.
        block = _extract_group_block(tmp, target, stable)
        combined_blocks += "\n" + block
        resolved[i] = stable
        if log_cb:
            log_cb(f"Custom group '{sel}' → {stable} ({last[1]} atoms"
                   + (f", union of {len(parts)} parts)" if multi else ")"))

    # Plain group NAMES get checked against the real group list while we have
    # it. Free here, and it turns "Protien" into a named mistake now rather than
    # a cryptic failure inside gmx mindist several seconds later. Only possible
    # on this path: with no custom selection there is no baseline to check
    # against, and building one just to validate would cost a make_ndx run per
    # replica.
    for i, g in enumerate(groups):
        name = str(g or "").strip()
        if not name or i in custom_idx or name.isdigit():
            continue
        if name not in base_names:
            near = [b for b in base_names if b.lower().startswith(name[:3].lower())]
            raise RuntimeError(
                f"'{name}' is not a group in this system. "
                + (f"Did you mean {', '.join(near[:4])}? " if near else "")
                + f"Available: {', '.join(base_names[:12])}"
                + (" …" if len(base_names) > 12 else ""))

    combined.write_text(combined_blocks)
    return resolved, str(combined)


def _diagnose_ndx_error(sel: str, stderr: str,
                        base_names: list[str] | None = None) -> str | None:
    """
    Turn make_ndx's terse C++ errors into something a user can act on.

    make_ndx surfaces problems as std::runtime_error / "Invalid selection" /
    "Group ... not found", often truncated in the UI to gibberish like
    "tandard library runti…". We recognise the common causes and explain them;
    returns None if nothing diagnostic was found (selection probably fine).
    """
    s = stderr.lower()

    # Referencing a group index or name that doesn't exist in this system.
    if "does not exist" in s or "not found" in s or "invalid group" in s:
        m = _re.match(r"\s*(\d+)\s*&", sel)
        if m:
            return (f"Group index {m.group(1)} does not exist for this system. "
                    f"Group indices are assigned per-system and differ between "
                    f"conditions — a group that was '3' in one build may be a "
                    f"different number here. Use a named group (e.g. 'Protein') "
                    f"or check the available groups first.")
        return ("A group referenced in this selection does not exist for this "
                "system. Use a named group like 'Protein', or the Structure tab "
                "to pick residues.")

    # AN UNQUOTED GROUP NAME. By far the most common way a sensible selection
    # is rejected, and the one GROMACS explains worst.
    #
    # Measured on gmx 2024.2:
    #     protein & ri 205-267    -> Syntax error, no group written
    #     "Protein" & ri 205-267  -> group Protein_&_r_205-267
    #
    # make_ndx needs a group NAME in double quotes when it appears inside an
    # expression. Bare, it is parsed as a keyword, and there is no keyword
    # called "protein". The message says only "Syntax error" and echoes the
    # line back, which tells the user nothing about the quotes.
    if base_names and ("syntax error" in s or "invalid selection" in s):
        bare = _re.sub(r'"[^"]*"', " ", sel)            # ignore what IS quoted
        by_lower = {b.lower(): b for b in base_names}
        # Words that follow a selection keyword are atom/residue names, not
        # group names: in 'ri 1 & a POT' the POT is an atom name.
        takes_a_name = {"a", "r", "ri", "t", "name", "chain", "atomname",
                        "resname"}
        tokens = _re.findall(r"[A-Za-z][A-Za-z0-9_+*\-]*", bare)
        for i, w in enumerate(tokens):
            if w.lower() in takes_a_name:
                continue
            if i and tokens[i - 1].lower() in takes_a_name:
                continue
            hit = by_lower.get(w.lower())
            if hit:
                fixed = _re.sub(r"\b" + _re.escape(w) + r"\b", f'"{hit}"',
                                sel, count=1)
                return (f'A group name has to be in double quotes inside an '
                        f'expression. Write \'{fixed}\' instead of \'{sel}\' '
                        f'— bare, \'{w}\' is read as a keyword and make_ndx '
                        f'reports a syntax error without saying why.')

    # Generic parse / runtime failure from a malformed expression.
    if ("runtime" in s or "invalid selection" in s or "syntax" in s
            or "cannot" in s or "error" in s):
        return (f"GROMACS could not parse this selection. Check the syntax — "
                f"e.g. 'ri 200-270', '\"Protein\" & ri 269' (group names need "
                f"the quotes), or pick residues in the Structure tab to avoid "
                f"typing indices by hand.\n"
                f"(GROMACS said: {stderr.strip()[-200:]})")

    return None


def _extract_last_group_block(ndx_path, new_name: str) -> str:
    """Read the last [ group ] block from an ndx and return it renamed."""
    return _extract_group_block(ndx_path, -1, new_name)


def _extract_group_block(ndx_path, index: int, new_name: str) -> str:
    """
    Read the `index`-th [ group ] block from an ndx and return it renamed.

    By INDEX, not "the last one": the build session also writes per-atom-name
    probe groups after the real one, so "last" would hand back a probe. That
    exact mistake produced a 1-atom group where 53 were asked for.
    """
    lines = Path(ndx_path).read_text().splitlines()
    hdrs = [i for i, l in enumerate(lines) if l.strip().startswith("[")]
    if not hdrs:
        raise RuntimeError(f"{Path(ndx_path).name} contains no groups.")
    start = hdrs[index]
    end = next((h for h in hdrs if h > start), len(lines))
    body_txt = "\n".join(l for l in lines[start + 1:end] if l.strip())
    return f"[ {new_name} ]\n{body_txt}\n"
