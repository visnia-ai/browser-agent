from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path


def run(arguments: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        check=True,
        capture_output=True,
        text=True,
        **kwargs,
    )


def main() -> None:
    if len(sys.argv) != 3:
        raise RuntimeError("Usage: verify-python-wheel <wheel> <manifest>")
    wheel = Path(sys.argv[1]).resolve()
    manifest_path = Path(sys.argv[2]).resolve()
    manifest_entry = "browser_agent/cli-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not wheel.name.endswith("-py3-none-any.whl"):
        raise RuntimeError(f"Python SDK wheel is not universal: {wheel}")
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        executables = sorted(
            name
            for name in names
            if name.startswith("browser_agent/bin/")
            and name.rsplit("/", 1)[-1] in {"browser-agent", "browser-agent.exe"}
        )
        if executables:
            raise RuntimeError(
                f"Universal wheel must not contain CLI executables: {executables}"
            )
        if manifest_entry not in names:
            raise RuntimeError(f"Wheel is missing its CLI manifest: {wheel}")
        packaged_manifest = json.loads(archive.read(manifest_entry))
        if packaged_manifest != manifest:
            raise RuntimeError("Wheel manifest differs from the release manifest")

    with tempfile.TemporaryDirectory(
        prefix="browser-agent-python-wheel-"
    ) as directory:
        environment = Path(directory) / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        scripts = environment / ("Scripts" if os.name == "nt" else "bin")
        python = scripts / ("python.exe" if os.name == "nt" else "python")
        run([str(python), "-m", "pip", "install", "--no-index", str(wheel)])
        probe = run(
            [
                str(python),
                "-c",
                (
                    "from browser_agent.runtime import cli_manifest;"
                    "print(cli_manifest().read_text(encoding='utf-8'))"
                ),
            ]
        )
        if json.loads(probe.stdout) != manifest:
            raise RuntimeError("Installed wheel manifest differs from release manifest")

    print("Universal Python SDK wheel verified.")


if __name__ == "__main__":
    main()
