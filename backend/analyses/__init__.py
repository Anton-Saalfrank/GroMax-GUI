"""Analysis module registry."""
from .rmsf import RMSFAnalysis
from .rmsd import RMSDAnalysis
from .gyrate import GyrateAnalysis
from .sasa import SASAAnalysis
from .hbond import HBondAnalysis
from .mindist import MindistAnalysis
from .ncontacts import NContactsAnalysis
from .sasa_nonpolar import NonpolarSASAAnalysis
from .rmsd2d import RMSD2DAnalysis
from .dssp import DSSPAnalysis
from .dccm import DCCMAnalysis
from .rmsf_rolling import RollingRMSFAnalysis
from .sasa_new import NewSASAAnalysis

REGISTRY = {
    "rmsf":    RMSFAnalysis,
    "rmsd":    RMSDAnalysis,
    "gyrate":  GyrateAnalysis,
    "sasa":    SASAAnalysis,
    "hbond":   HBondAnalysis,
    "mindist": MindistAnalysis,
    "ncontacts": NContactsAnalysis,
    "sasa_nonpolar": NonpolarSASAAnalysis,
    "rmsd2d":  RMSD2DAnalysis,
    "dssp":    DSSPAnalysis,
    "dccm":    DCCMAnalysis,
    "rmsf_rolling": RollingRMSFAnalysis,
    "sasa_new": NewSASAAnalysis,
}

def get_analysis(analysis_type: str):
    cls = REGISTRY.get(analysis_type)
    if not cls:
        raise ValueError(f"Unknown analysis type: {analysis_type}")
    return cls()

def list_analyses():
    return [cls().describe() for cls in REGISTRY.values()]
