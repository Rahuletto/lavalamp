"""
Harbor agent adapter for lavalamp.

Installs lavalamp (bun + repo) inside a Harbor-managed container and drives it
via the non-interactive print mode (`lavalamp -p "..." --sudo --quiet`).

Usage:
    harbor run -d terminal-bench/terminal-bench-2-1 \
        --agent bench.agent:LavalampAgent \
        --model cloudflare-workers-ai/@cf/zai-org/glm-4.7-flash
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    EnvVar,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)

# Minimum bun version that lavalamp requires
_BUN_MIN_VERSION = "1.3.14"

# Session data lives here inside the container (Linux XDG default)
_CONTAINER_SESSION_DIR = "$HOME/.local/share/lavalamp/sessions"


class LavalampAgent(BaseInstalledAgent):
    """Harbor adapter for the lavalamp AI coding harness."""

    SUPPORTS_ATIF: bool = True
    SUPPORTS_RESUME: bool = False

    CLI_FLAGS = [
        CliFlag(
            "max_turns",
            cli="--max-turns",
            type="int",
            env_fallback="LAVALAMP_MAX_TURNS",
        ),
        CliFlag(
            "model",
            cli="--model",
            type="str",
            env_fallback="LAVALAMP_MODEL",
        ),
    ]

    ENV_VARS = [
        # Cloudflare Workers AI credentials
        EnvVar("cf_account_id", env="CF_ACCOUNT_ID", type="str",
               env_fallback="CF_ACCOUNT_ID"),
        EnvVar("cf_api_token", env="CF_API_TOKEN", type="str",
               env_fallback="CF_API_TOKEN"),
        # BYOK provider keys
        EnvVar("anthropic_api_key", env="ANTHROPIC_API_KEY", type="str",
               env_fallback="ANTHROPIC_API_KEY"),
        EnvVar("openai_api_key", env="OPENAI_API_KEY", type="str",
               env_fallback="OPENAI_API_KEY"),
        EnvVar("openrouter_api_key", env="OPENROUTER_API_KEY", type="str",
               env_fallback="OPENROUTER_API_KEY"),
    ]

    _INSTALL_CHECK_COMMAND = (
        'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; '
        'command -v lavalamp >/dev/null 2>&1'
    )

    @staticmethod
    @override
    def name() -> str:
        return "lavalamp"

    @override
    def get_version_command(self) -> str | None:
        return (
            'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; '
            'lavalamp --version'
        )

    @override
    def parse_version(self, stdout: str) -> str:
        import re

        text = stdout.strip()
        match = re.search(r"(\d+\.\d+\.\d+)", text)
        if match:
            return match.group(1)
        return text

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Check if already installed
        check = await environment.exec(command=self._INSTALL_CHECK_COMMAND)
        if check.return_code == 0:
            self.logger.debug("lavalamp is already installed")
            return

        # Install system dependencies (as root)
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apk &> /dev/null; then"
                "  apk add --no-cache curl bash git unzip;"
                " elif command -v apt-get &> /dev/null; then"
                "  apt-get update && apt-get install -y curl git unzip;"
                " elif command -v yum &> /dev/null; then"
                "  yum install -y curl git unzip;"
                " fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        # Install bun (as agent user)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "curl -fsSL https://bun.sh/install | bash -s -- "
                f"bun-v{_BUN_MIN_VERSION} && "
                'echo \'export PATH="$HOME/.bun/bin:$PATH"\' >> ~/.bashrc && '
                'export PATH="$HOME/.bun/bin:$PATH" && '
                "bun --version"
            ),
        )

        # Copy repository from host to container (since it is a private repo)
        import tempfile
        import tarfile
        import subprocess
        from pathlib import Path

        # Get container ID using hostname inside the container
        hostname_res = await environment.exec(command="hostname")
        container_id = hostname_res.stdout.strip()
        if not container_id:
            raise ValueError("Failed to retrieve container ID")

        repo_root = Path(__file__).resolve().parent.parent

        with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            with tarfile.open(tmp_path, "w") as tar:
                def exclude_func(tarinfo):
                    parts = Path(tarinfo.name).parts
                    exclude_names = {
                        "node_modules",
                        ".git",
                        ".github",
                        ".cache",
                        "website",
                        ".flue-vite",
                        "jobs",
                        "tests"
                    }
                    if any(p in exclude_names for p in parts):
                        return None
                    return tarinfo

                tar.add(repo_root, arcname="lavalamp", filter=exclude_func)

            # Copy the tar archive into the container
            subprocess.run(
                ["docker", "cp", str(tmp_path), f"{container_id}:/tmp/lavalamp.tar"],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

        # Extract the repository and install dependencies
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "mkdir -p $HOME/.lavalamp-src && "
                "tar -xf /tmp/lavalamp.tar -C $HOME/.lavalamp-src --strip-components=1 && "
                "rm -f /tmp/lavalamp.tar && "
                'export PATH="$HOME/.bun/bin:$PATH"; '
                "cd $HOME/.lavalamp-src && "
                "bun install && "
                "bun run build && "
                'mkdir -p "$HOME/.local/bin" && '
                'ln -sf "$HOME/.lavalamp-src/bin/lavalamp" "$HOME/.local/bin/lavalamp" && '
                'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc && '
                'export PATH="$HOME/.local/bin:$PATH" && '
                "lavalamp --version"
            ),
        )

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        cmd_parts = [
            'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"',
            "cd /workspace",
        ]

        lavalamp_cmd = "lavalamp -p {prompt} --sudo --quiet --output-format json".format(
            prompt=shlex.quote(instruction),
        )

        # Pass model if specified
        model = self._resolve_model()
        if model:
            lavalamp_cmd = "LAVALAMP_MODEL={model} {cmd}".format(
                model=shlex.quote(model),
                cmd=lavalamp_cmd,
            )

        cmd_parts.append(lavalamp_cmd)
        command = " && ".join(cmd_parts)

        result = await self.exec_as_agent(
            environment,
            command=command,
            timeout=self.timeout,
        )

        # Parse JSON output
        if result.stdout:
            self._parse_output(result.stdout, context)

        # Extract session file from the container for ATIF trajectory
        session_result = await self.exec_as_agent(
            environment,
            command=(
                'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; '
                f'SESSION_DIR="{_CONTAINER_SESSION_DIR}"; '
                'if [ -d "$SESSION_DIR" ]; then '
                '  LATEST=$(ls -t "$SESSION_DIR"/*.json 2>/dev/null | head -1); '
                '  if [ -n "$LATEST" ]; then cat "$LATEST"; fi; '
                "fi"
            ),
        )

        if session_result.stdout and session_result.stdout.strip():
            session_path = self.logs_dir / "session.json"
            session_path.write_text(session_result.stdout)
            self.logger.debug("Saved lavalamp session to %s", session_path)

    def _resolve_model(self) -> str | None:
        if self.model_name:
            return self.model_name
        return os.environ.get("LAVALAMP_MODEL")

    def _parse_output(self, stdout: str, context: AgentContext) -> None:
        for line in stdout.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                if "error" in data:
                    self.logger.error("lavalamp error: %s", data["error"])
                    context.error = data["error"]
                elif "text" in data:
                    context.output = data.get("text", "")
                    if "usage" in data:
                        context.metadata = context.metadata or {}
                        context.metadata["usage"] = data["usage"]
                    if "model" in data:
                        context.metadata = context.metadata or {}
                        context.metadata["model"] = data["model"]
            except json.JSONDecodeError:
                self.logger.debug("Non-JSON output line: %s", line[:200])

    # ── ATIF trajectory conversion ────────────────────────────────────

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse lavalamp session JSON into an ATIF Trajectory."""
        session_path = self.logs_dir / "session.json"
        if not session_path.exists():
            self.logger.warning("No session file found for ATIF trajectory")
            return

        try:
            session = json.loads(session_path.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            self.logger.error("Failed to parse session file: %s", exc)
            return

        messages = session.get("messages", [])
        if not messages:
            self.logger.warning("Session contains no messages")
            return

        steps: list[Step] = []
        step_id = 0

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            thinking = msg.get("thinking")
            tool_calls_raw = msg.get("toolCalls", [])
            timestamp = msg.get("timestamp")
            ts_str = self._ts_to_iso(timestamp) if timestamp else None

            if role == "user":
                steps.append(Step(
                    step_id=step_id,
                    timestamp=ts_str,
                    source="user",
                    message=content,
                ))
                step_id += 1
                continue

            # Assistant message — may have thinking + tool calls
            if role == "assistant":
                # If there are tool calls, emit one step per tool call
                if tool_calls_raw:
                    for tc in tool_calls_raw:
                        tc_id = tc.get("id", f"call_{step_id}")
                        tc_name = tc.get("name", "unknown")
                        tc_args = tc.get("args", {})
                        tc_result = tc.get("result")
                        tc_error = tc.get("isError", False)
                        tc_duration = tc.get("durationMs")

                        tool_call = ToolCall(
                            tool_call_id=tc_id,
                            function_name=tc_name,
                            arguments=tc_args,
                        )

                        observation = None
                        if tc_result is not None:
                            result_content = (
                                tc_result
                                if isinstance(tc_result, str)
                                else json.dumps(tc_result, ensure_ascii=False,
                                                default=str)
                            )
                            # Truncate huge results to keep trajectory readable
                            if len(result_content) > 10_000:
                                result_content = (
                                    result_content[:10_000]
                                    + "\n... [truncated]"
                                )
                            observation = Observation(
                                results=[ObservationResult(
                                    source_call_id=tc_id,
                                    content=result_content,
                                    subagent_trajectory_ref=None,
                                )]
                            )

                        step = Step(
                            step_id=step_id,
                            timestamp=ts_str,
                            source="agent",
                            message=content if step_id == 0 or not tool_calls_raw else "",
                            tool_calls=[tool_call],
                            observation=observation,
                            llm_call_count=1,
                        )

                        if thinking:
                            step.reasoning_content = thinking
                            thinking = None  # Only attach to first step

                        if self.model_name:
                            step.model_name = self.model_name

                        if tc_duration is not None:
                            step.extra = {"duration_ms": tc_duration}

                        steps.append(step)
                        step_id += 1
                else:
                    # Pure text response, no tool calls
                    step = Step(
                        step_id=step_id,
                        timestamp=ts_str,
                        source="agent",
                        message=content,
                        llm_call_count=1,
                    )
                    if thinking:
                        step.reasoning_content = thinking
                    if self.model_name:
                        step.model_name = self.model_name
                    steps.append(step)
                    step_id += 1

        if steps:
            context.trajectory = Trajectory(steps=steps)
            self.logger.info(
                "Built ATIF trajectory with %d steps from lavalamp session",
                len(steps),
            )

    @staticmethod
    def _ts_to_iso(ts: int | float | None) -> str | None:
        if ts is None:
            return None
        from datetime import datetime, timezone

        # lavalamp timestamps are ms since epoch
        try:
            dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
            return dt.isoformat()
        except (OSError, ValueError, OverflowError):
            return None
