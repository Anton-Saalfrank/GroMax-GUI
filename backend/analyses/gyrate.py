"""Radius of gyration over time (gmx gyrate)."""
from .base import BaseAnalysis


class GyrateAnalysis(BaseAnalysis):
    type_id = "gyrate"
    name = "Radius of gyration"
    description = "Rg vs time — compactness of the structure."
    gmx_tool = "gyrate"
    n_groups = 1
    group_prompts = ["Group for Rg calculation"]
    default_groups = ["Protein", "Backbone", "C-alpha"]

    x_is_time = True
    default_ylabel = "Rg (nm)"
    plot_title = "Radius of gyration vs time"
