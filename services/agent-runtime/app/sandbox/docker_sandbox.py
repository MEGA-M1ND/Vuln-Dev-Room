"""Docker implementation of the Sandbox.

Isolation model for the agent phase — where model-produced edits and
model-chosen test commands actually execute (all enforced on `docker run`):
  --network=none            no network at all
  --cap-drop=ALL            drop every Linux capability
  --security-opt=no-new-privileges
  --user 1000:1000          non-root
  --read-only               root filesystem is immutable
  --tmpfs /tmp              the ONLY writable area (the workspace lives here)
  --memory / --pids-limit / --cpus   resource caps
  (no bind mounts at all — the repo is copied in with `docker cp`)

Repositories that declare third-party dependencies (requirements.txt /
pyproject.toml) go through an additional SETUP PHASE first (see
_run_setup_phase): a short-lived, network-enabled, writable-root container
runs exactly one fixed, code-selected install command (never one derived from
model output — see app/sandbox/setup.py), then is `docker commit`-ed to a
per-run snapshot image. The agent-phase container above is then started FROM
that snapshot instead of the static base image, so it already has the
dependencies on disk, while still never touching the network itself. Repos
with no manifest skip the setup phase entirely — today's behaviour.

The host repository is copied to a staging dir, chowned to the sandbox uid, and
`docker cp`-ed into the container's tmpfs workspace, so the source repository is
never mounted and never modified. There is deliberately NO host-execution path.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import uuid

from app.config import Settings
from app.sandbox.base import (
    CommandResult,
    PatchResult,
    PreparedRepository,
    SandboxError,
    SandboxSetupError,
    SandboxUnavailableError,
)
from app.sandbox.setup import detect_install_command

WORKDIR = "/tmp/work"
SANDBOX_UID = 1000
SANDBOX_HOME = "/home/agent"
# Installed dependencies live outside /tmp so they survive into the agent
# phase: the agent container mounts a fresh tmpfs over /tmp, which would
# otherwise shadow anything baked in there by the setup-phase commit.
PYTHON_USER_BASE = f"{SANDBOX_HOME}/pydeps"
# Output is stored on the run event/artifact; cap it well below Postgres's
# practical comfort zone for a text column.
MAX_SETUP_OUTPUT_CHARS = 8_000


def ensure_docker_available() -> None:
    """Raise SandboxUnavailableError unless a working Docker daemon is present."""
    if shutil.which("docker") is None:
        raise SandboxUnavailableError("The 'docker' CLI is not installed.")
    try:
        proc = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise SandboxUnavailableError(f"Docker daemon is not reachable: {exc}") from exc
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SandboxUnavailableError(
            "Docker daemon is not reachable (is it running?)."
        )


class DockerSandbox:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.sandbox_id = f"sbx_{uuid.uuid4().hex}"
        self._container_id: str | None = None
        # Set only when a setup phase ran; cleanup() removes this image too.
        self._snapshot_image: str | None = None
        self._logs: list[str] = []

    # -- lifecycle ----------------------------------------------------------

    def prepare_repository(self, source_path: str) -> PreparedRepository:
        ensure_docker_available()
        if not os.path.isdir(source_path):
            raise SandboxError(f"Repository source path does not exist: {source_path}")
        if not os.path.isdir(os.path.join(source_path, ".git")):
            raise SandboxError("Configured repository source is not a Git repository.")

        agent_image = self._settings.sandbox_image
        dependencies_installed = False
        setup_output = ""

        install_cmd = (
            detect_install_command(source_path)
            if self._settings.dependency_setup_enabled
            else None
        )
        if install_cmd is not None:
            agent_image, setup_output = self._run_setup_phase(source_path, install_cmd)
            dependencies_installed = True

        staging = tempfile.mkdtemp(prefix="devroom-stage-")
        try:
            # Copy the repo (including .git) so the source is never touched.
            repo_copy = os.path.join(staging, "work")
            shutil.copytree(source_path, repo_copy, symlinks=False)

            self._container_id = self._start_agent_container(agent_image)

            # Stream the tree into the container's writable tmpfs via exec+tar.
            # This runs as the non-root sandbox user and works even with a
            # read-only root filesystem (docker cp does not).
            self._exec(["mkdir", "-p", WORKDIR])
            tar_bytes = subprocess.run(
                ["tar", "-C", repo_copy, "-c", "."],
                capture_output=True,
                check=True,
            ).stdout
            extract = self._exec(["tar", "-C", WORKDIR, "-x"], stdin=tar_bytes)
            if extract.exit_code != 0:
                raise SandboxError(f"Failed to load repository: {extract.stderr.strip()}")
            # Keep transient build artifacts out of the captured diff.
            self._exec(
                [
                    "sh",
                    "-c",
                    f"printf '%s\\n' '__pycache__/' '*.pyc' '.pytest_cache/' "
                    f">> {WORKDIR}/.git/info/exclude",
                ]
            )
        finally:
            shutil.rmtree(staging, ignore_errors=True)

        base_revision = self._exec(["git", "-C", WORKDIR, "rev-parse", "HEAD"]).stdout.strip()
        tree = self._list_tree()
        return PreparedRepository(
            base_revision=base_revision,
            tree=tree,
            dependencies_installed=dependencies_installed,
            setup_output=setup_output,
        )

    def cleanup(self) -> None:
        if self._container_id:
            subprocess.run(
                ["docker", "rm", "-f", self._container_id],
                capture_output=True,
                text=True,
            )
            self._container_id = None
        if self._snapshot_image:
            subprocess.run(
                ["docker", "rmi", "-f", self._snapshot_image],
                capture_output=True,
                text=True,
            )
            self._snapshot_image = None

    # -- read / search ------------------------------------------------------

    def read_file(self, rel_path: str) -> str:
        result = self._exec(["cat", f"{WORKDIR}/{rel_path}"])
        if result.exit_code != 0:
            raise SandboxError(f"Could not read {rel_path}: {result.stderr.strip()}")
        return result.stdout

    def search_repository(self, query: str, max_results: int = 50) -> list[str]:
        # git grep stays within tracked files; -I skips binaries, -n adds lines.
        result = self._exec(
            ["sh", "-c", f"cd {WORKDIR} && git grep -I -n -e {_shell_quote(query)} || true"]
        )
        lines = [ln for ln in result.stdout.splitlines() if ln.strip()]
        return lines[:max_results]

    def list_tree(self) -> list[str]:
        return self._list_tree()

    # -- mutate -------------------------------------------------------------

    def apply_patch(self, rel_path: str, new_content: str) -> PatchResult:
        exists = self._exec(["test", "-f", f"{WORKDIR}/{rel_path}"]).exit_code == 0
        parent = os.path.dirname(rel_path)
        if parent:
            self._exec(["mkdir", "-p", f"{WORKDIR}/{parent}"])
        # Write the file by piping content to `cat` inside the container. Runs as
        # the non-root sandbox user directly into the tmpfs workspace — no host
        # bind mount, no shell escaping of the content.
        result = self._exec(
            ["sh", "-c", f"cat > {WORKDIR}/{rel_path}"],
            stdin=new_content.encode("utf-8"),
        )
        if result.exit_code != 0:
            raise SandboxError(f"Failed to write {rel_path}: {result.stderr.strip()}")
        return PatchResult(
            path=rel_path,
            applied=True,
            created=not exists,
            message="created" if not exists else "modified",
        )

    # -- tests / diff -------------------------------------------------------

    def run_tests(self, test_command: str) -> CommandResult:
        return self._exec(
            ["sh", "-c", f"cd {WORKDIR} && {test_command}"],
            timeout=self._settings.sandbox_command_timeout,
        )

    def get_git_diff(self) -> str:
        result = self._exec(
            ["sh", "-c", f"cd {WORKDIR} && git add -A && git diff --cached"]
        )
        return result.stdout

    def get_git_status(self) -> str:
        return self._exec(["git", "-C", WORKDIR, "status", "--porcelain"]).stdout

    def collect_logs(self) -> str:
        return "\n".join(self._logs)

    # -- setup phase (network-enabled, writable root) ------------------------

    def _run_setup_phase(
        self, source_path: str, install_cmd: list[str]
    ) -> tuple[str, str]:
        """Install the repo's own declared dependencies, then snapshot the
        result as a per-run image. Network access and filesystem write access
        exist ONLY on the short-lived container this method owns — it never
        touches self._container_id, which is the agent-phase container created
        afterward with network disabled again.
        """
        staging = tempfile.mkdtemp(prefix="devroom-setup-")
        setup_container_id: str | None = None
        try:
            repo_copy = os.path.join(staging, "work")
            shutil.copytree(source_path, repo_copy, symlinks=False)

            setup_container_id = self._start_setup_container()
            self._exec(["mkdir", "-p", WORKDIR], container_id=setup_container_id)
            tar_bytes = subprocess.run(
                ["tar", "-C", repo_copy, "-c", "."],
                capture_output=True,
                check=True,
            ).stdout
            extract = self._exec(
                ["tar", "-C", WORKDIR, "-x"],
                stdin=tar_bytes,
                container_id=setup_container_id,
            )
            if extract.exit_code != 0:
                raise SandboxSetupError(
                    f"Failed to load repository for setup: {extract.stderr.strip()}"
                )

            quoted_cmd = " ".join(_shell_quote(part) for part in install_cmd)
            result = self._exec(
                ["sh", "-c", f"cd {WORKDIR} && {quoted_cmd}"],
                timeout=self._settings.sandbox_setup_timeout,
                container_id=setup_container_id,
            )
            output = f"$ {' '.join(install_cmd)}\n{result.stdout}{result.stderr}"
            output = output[:MAX_SETUP_OUTPUT_CHARS]
            if result.exit_code != 0:
                raise SandboxSetupError(
                    "Dependency installation failed "
                    f"(exit {result.exit_code}): {result.stderr.strip()[:2000]}"
                )

            tag = f"devroom-sandbox-{self.sandbox_id}"
            commit = subprocess.run(
                ["docker", "commit", setup_container_id, tag],
                capture_output=True,
                text=True,
            )
            if commit.returncode != 0:
                raise SandboxSetupError(
                    f"Could not snapshot the prepared sandbox: {commit.stderr.strip()}"
                )
            self._snapshot_image = tag
            return tag, output
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            if setup_container_id:
                subprocess.run(
                    ["docker", "rm", "-f", setup_container_id],
                    capture_output=True,
                    text=True,
                )

    def _start_setup_container(self) -> str:
        """Network ON, root filesystem writable. Every other hardening flag
        (capabilities, privilege escalation, non-root, resource limits) is
        unchanged from the agent phase — only isolation properties that a
        dependency install genuinely needs are relaxed, and only for this
        short-lived container that never runs model-produced commands."""
        mem = self._settings.sandbox_memory
        args = [
            "docker", "run", "-d",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            f"--user={SANDBOX_UID}:{SANDBOX_UID}",
            f"--memory={mem}",
            f"--pids-limit={self._settings.sandbox_pids_limit}",
            f"--cpus={self._settings.sandbox_cpus}",
            "--env", f"HOME={SANDBOX_HOME}",
            "--env", f"PYTHONUSERBASE={PYTHON_USER_BASE}",
            "--env", "GIT_TERMINAL_PROMPT=0",
            "--workdir", "/tmp",
            self._settings.sandbox_image,
            "sleep", "86400",
        ]
        proc = self._sh(args)
        return proc.stdout.strip()

    # -- agent phase (network=none, read-only root) --------------------------

    def _start_agent_container(self, image: str) -> str:
        mem = self._settings.sandbox_memory
        args = [
            "docker", "run", "-d",
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            f"--user={SANDBOX_UID}:{SANDBOX_UID}",
            "--read-only",
            f"--tmpfs=/tmp:mode=1777,size={mem}",
            f"--memory={mem}",
            f"--pids-limit={self._settings.sandbox_pids_limit}",
            f"--cpus={self._settings.sandbox_cpus}",
            "--env", "HOME=/tmp",
            "--env", f"PYTHONUSERBASE={PYTHON_USER_BASE}",
            "--env", "GIT_CONFIG_GLOBAL=/tmp/.gitconfig",
            "--env", "GIT_TERMINAL_PROMPT=0",
            "--workdir", "/tmp",
            image,
            "sleep", "86400",
        ]
        proc = self._sh(args)
        return proc.stdout.strip()

    def _list_tree(self) -> list[str]:
        result = self._exec(["git", "-C", WORKDIR, "ls-files"])
        return [ln for ln in result.stdout.splitlines() if ln.strip()]

    def _exec(
        self,
        cmd: list[str],
        timeout: int | None = None,
        stdin: bytes | None = None,
        container_id: str | None = None,
    ) -> CommandResult:
        target = container_id or self._container_id
        if not target:
            raise SandboxError("Sandbox container is not running.")
        flags = ["-i"] if stdin is not None else []
        full = ["docker", "exec", *flags, target, *cmd]
        try:
            proc = subprocess.run(
                full,
                input=stdin,
                capture_output=True,
                timeout=timeout or self._settings.sandbox_command_timeout,
            )
        except subprocess.TimeoutExpired as exc:
            self._logs.append(f"$ {' '.join(cmd)}\n[timed out]")
            out = exc.stdout.decode("utf-8", "replace") if exc.stdout else ""
            return CommandResult(
                exit_code=124, stdout=out, stderr="Command timed out.", timed_out=True
            )
        stdout = proc.stdout.decode("utf-8", "replace")
        stderr = proc.stderr.decode("utf-8", "replace")
        self._logs.append(f"$ {' '.join(cmd)}\n(exit {proc.returncode})\n{stdout}{stderr}")
        return CommandResult(exit_code=proc.returncode, stdout=stdout, stderr=stderr)

    def _sh(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            raise SandboxError(
                f"Docker command failed: {' '.join(args[:3])}…: {proc.stderr.strip()}"
            )
        return proc


def _shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"
