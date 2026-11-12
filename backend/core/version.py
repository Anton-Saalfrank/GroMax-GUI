"""
Single source of truth for the application version.

This previously lived in four places that disagreed: package.json said 0.1.0,
the /health endpoint said 0.1.0, the FastAPI app said 0.1.0, and the README
documented "v37" behaviour. Keep this in step with package.json and the git tag.
"""

__version__ = "1.0.0"
