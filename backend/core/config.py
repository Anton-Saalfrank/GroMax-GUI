"""Central configuration for the GroMax backend."""

from pathlib import Path
from pydantic_settings import BaseSettings
import os


class Settings(BaseSettings):
    # Where all projects live
    projects_dir: Path = Path.home() / ".gromax" / "projects"

    # GROMACS executable name (override if using gmx_mpi etc.)
    gmx_executable: str = "gmx"

    # Max parallel jobs
    max_parallel_jobs: int = 4

    @property
    def archive_dir(self) -> Path:
        """
        Where archived projects go — a sibling of projects_dir, not a child.

        A child directory would be walked by list_sessions(), so an archived
        project would still appear on the home screen, and a `rm -rf projects/`
        would take the archive with it. Derived from projects_dir rather than
        hard-coded so a custom GROMAX_PROJECTS_DIR keeps the two together.
        """
        return self.projects_dir.parent / "archive"

    # Environment
    env: str = os.environ.get("GROMAX_ENV", "development")

    class Config:
        env_prefix = "GROMAX_"


settings = Settings()
