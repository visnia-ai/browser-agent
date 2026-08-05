from __future__ import annotations

import json
import os
import tomllib
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        if self.target_name != "wheel":
            raise RuntimeError(
                "The Python SDK is distributed as a wheel only; source "
                "distributions are unsupported."
            )
        manifest_value = os.environ.get("BROWSER_AGENT_CLI_MANIFEST")
        if not manifest_value:
            raise RuntimeError(
                "Wheel builds require BROWSER_AGENT_CLI_MANIFEST."
            )
        manifest_path = Path(manifest_value).resolve()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        with (Path(self.root) / "pyproject.toml").open("rb") as project_file:
            project_version = tomllib.load(project_file)["project"]["version"]
        if manifest.get("version") != project_version:
            raise RuntimeError(
                f"CLI manifest version {manifest.get('version')} does not "
                f"match Python package version {project_version}."
            )
        platforms = manifest.get("platforms")
        if not isinstance(platforms, dict) or not platforms:
            raise RuntimeError("CLI manifest does not contain any platforms.")
        force_include = build_data.setdefault("force_include", {})
        force_include[str(manifest_path)] = "browser_agent/cli-manifest.json"
        build_data["pure_python"] = True
        build_data["tag"] = "py3-none-any"
