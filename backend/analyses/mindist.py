"""Minimum distance between two groups vs time (gmx mindist)."""
from .base import BaseAnalysis


class MindistAnalysis(BaseAnalysis):
    type_id = "mindist"
    name = "Minimum distance"
    description = "Minimum distance between two groups vs time."
    gmx_tool = "mindist"
    n_groups = 2
    group_prompts = ["First group", "Second group"]
    default_groups = ["Protein", "Protein"]

    out_flag = "-od"                   # gmx mindist writes distances to -od
    x_is_time = True
    default_ylabel = "Min. distance (nm)"
    plot_title = "Minimum distance vs time"
