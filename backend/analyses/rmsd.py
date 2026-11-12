"""RMSD — root mean square deviation over time (gmx rms)."""
from .base import BaseAnalysis


class RMSDAnalysis(BaseAnalysis):
    type_id = "rmsd"
    name = "RMSD"
    description = "Root-mean-square deviation vs time — overall structural drift."
    gmx_tool = "rms"
    n_groups = 2
    group_prompts = ["Group for least-squares fit", "Group for RMSD calculation"]
    default_groups = ["Backbone", "C-alpha", "Protein"]

    # NOTE: no -tu ns. Output x is in ps; base.parse() converts to ns because
    # x_is_time is True. See the module docstring in base.py for why -tu is
    # avoided (it reinterprets -b/-e on some builds → 1000x error).
    x_is_time = True
    default_ylabel = "RMSD (nm)"
    plot_title = "RMSD vs time"
