"""RMSF — per-residue root mean square fluctuation (gmx rmsf)."""
from .base import BaseAnalysis


class RMSFAnalysis(BaseAnalysis):
    type_id = "rmsf"
    name = "RMSF"
    description = "Per-residue root-mean-square fluctuation — flexibility per residue."
    gmx_tool = "rmsf"
    n_groups = 1
    group_prompts = ["Group for RMSF calculation"]
    default_groups = ["C-alpha", "Backbone", "Protein"]

    extra_args = ["-res"]              # per-residue averaging
    x_is_time = False                  # x is residue number, not time
    default_xlabel = "Residue"
    default_ylabel = "RMSF (nm)"
    plot_title = "RMSF per residue"
