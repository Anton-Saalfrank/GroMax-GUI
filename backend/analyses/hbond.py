"""Hydrogen bonds vs time (gmx hbond)."""
from .base import BaseAnalysis


class HBondAnalysis(BaseAnalysis):
    type_id = "hbond"
    name = "Hydrogen bonds"
    description = "Number of H-bonds vs time between two groups."
    gmx_tool = "hbond"
    n_groups = 2
    group_prompts = ["Donor group", "Acceptor group"]
    default_groups = ["Protein", "Protein"]

    out_flag = "-num"                  # gmx hbond writes the count to -num
    x_is_time = True
    default_ylabel = "H-bonds"
    plot_title = "Hydrogen bonds vs time"
