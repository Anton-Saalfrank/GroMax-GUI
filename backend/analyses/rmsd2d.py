"""2D-RMSD matrix — RMSD of each frame against every other frame (gmx rms -m)."""
from pathlib import Path
from .base import BaseAnalysis


class RMSD2DAnalysis(BaseAnalysis):
    type_id = "rmsd2d"
    name = "2D-RMSD matrix"
    description = "All-vs-all frame RMSD — reveals conformational clusters over time."
    gmx_tool = "rms"
    n_groups = 2
    group_prompts = ["Group for least-squares fit", "Group for RMSD"]
    default_groups = ["Backbone", "C-alpha", "Protein"]
    x_is_time = False

    def build_args(self, ctx: dict) -> list[str]:
        # -m produces an XPM matrix; we convert to data via -m then read XPM.
        xpm = ctx["_out_xvg"].with_suffix(".xpm")
        ctx["_xpm"] = xpm
        args = [
            "-s", ctx["tpr"],
            "-f", ctx["xtc"],
            "-o", str(ctx["_out_xvg"]),   # still need -o (rmsd vs time)
            "-m", str(xpm),
        ]
        if ctx.get("ndx"):
            args += ["-n", ctx["ndx"]]
        args += self.frame_args(ctx)
        return args

    def parse(self, output_xvg: Path, ctx: dict) -> dict:
        xpm = ctx.get("_xpm")
        if not xpm or not Path(xpm).exists():
            raise RuntimeError("2D-RMSD matrix (.xpm) was not produced.")
        matrix, meta = parse_xpm(Path(xpm))
        n = len(matrix)
        return {
            "kind": "heatmap",
            "z": matrix,
            "x": list(range(n)),
            "y": list(range(n)),
            "xlabel": "Frame",
            "ylabel": "Frame",
            "zlabel": meta.get("legend", "RMSD (nm)"),
            "title": "2D-RMSD (frame vs frame)",
        }


def parse_xpm(xpm_path: Path):
    """
    Parse a GROMACS .xpm file into a 2D numeric matrix.
    XPM encodes each cell as a character mapped to a value via the colour legend.
    """
    lines = xpm_path.read_text().splitlines()
    # Find the colour map: lines like  "A  c #FFFFFF  /* "0" */"
    char_to_val = {}
    legend = ""
    data_rows = []
    dims = None
    in_data = False
    header_seen = False

    for ln in lines:
        s = ln.strip()
        if s.startswith("/* x-axis") or s.startswith("/* y-axis"):
            continue
        if s.startswith('"') and not header_seen and dims is None:
            # First quoted line after static char *... is the dimensions:
            # "width height ncolors chars_per_pixel"
            inner = s.split('"')[1]
            parts = inner.split()
            if len(parts) >= 4:
                try:
                    w, h, ncolors, cpp = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
                    dims = (w, h, ncolors, cpp)
                    header_seen = True
                    continue
                except ValueError:
                    pass
        if dims and len(char_to_val) < dims[2] and s.startswith('"') and " c " in s:
            # Colour legend line: "X  c #RRGGBB  /* "value" */"
            char = s.split('"')[1][:dims[3]]
            # value in the trailing comment
            val = None
            if "/*" in s and "*/" in s:
                comment = s[s.index("/*")+2 : s.rindex("*/")].strip().strip('"')
                try:
                    val = float(comment)
                except ValueError:
                    val = None
            char_to_val[char] = val if val is not None else len(char_to_val)
            continue
        if dims and header_seen and len(char_to_val) >= dims[2]:
            # Remaining quoted lines are pixel rows
            if s.startswith('"'):
                row_str = s.split('"')[1]
                cpp = dims[3]
                row = []
                for i in range(0, len(row_str), cpp):
                    ch = row_str[i:i+cpp]
                    row.append(char_to_val.get(ch, 0.0))
                data_rows.append(row)

    # XPM rows are top-to-bottom; flip so origin is bottom-left
    data_rows.reverse()
    return data_rows, {"legend": legend}
