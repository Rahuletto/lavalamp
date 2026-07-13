"""
Harbor agent adapter for lavalamp.

Copies a prebuilt lavalamp Linux executable into each Harbor-managed container
and drives it via non-interactive print mode (`lavalamp -p "..." --sudo`).

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

        # Copy the prebuilt Linux x64 executable into the container. Building
        # from source here makes every trial depend on bun.sh and the package
        # registry, and adds minutes of redundant setup work.
        import subprocess

        hostname_res = await environment.exec(command="hostname")
        container_id = hostname_res.stdout.strip()
        if not container_id:
            raise ValueError("Failed to retrieve container ID")

        repo_root = Path(__file__).resolve().parent.parent
        binary_path = repo_root / "dist" / "lavalamp"
        if not binary_path.is_file():
            raise FileNotFoundError(
                f"Prebuilt benchmark binary not found: {binary_path}. "
                "Build dist/lavalamp for Linux x64 before running Harbor."
            )

        subprocess.run(
            ["docker", "cp", str(binary_path), f"{container_id}:/tmp/lavalamp"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        await self.exec_as_root(
            environment,
            command=(
                "install -m 0755 /tmp/lavalamp /usr/local/bin/lavalamp && "
                "rm -f /tmp/lavalamp && "
                "/usr/local/bin/lavalamp --version"
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
        ]

        # Use text mode without --quiet so Harbor streams tool activity into the
        # trial log while the command is running. JSON mode intentionally hides
        # Lavalamp's live bash/tool output.
        lavalamp_cmd = "lavalamp -p {prompt} --sudo".format(
            prompt=shlex.quote(instruction),
        )

        # Pass model if specified
        model = self._resolve_model()
        if model:
            lavalamp_cmd = "LAVALAMP_MODEL={model} {cmd}".format(
                model=shlex.quote(model),
                cmd=lavalamp_cmd,
            )

        # Run Lavalamp with its output attached to a regular file, then tail
        # that file for Harbor. Task solutions often start a service with `&`;
        # if that service inherits Docker exec's stdout pipe, Harbor never sees
        # EOF and incorrectly reports an agent timeout after Lavalamp exits.
        # Descendants may keep the file open without keeping the exec pipe open.
        cmd_parts.append(
            'OUTPUT_FILE=$(mktemp); '
            'trap \'rm -f "$OUTPUT_FILE"\' EXIT; '
            f'({lavalamp_cmd}) >"$OUTPUT_FILE" 2>&1 & '
            'LAVALAMP_PID=$!; '
            'tail -n +1 -f "$OUTPUT_FILE" & '
            'TAIL_PID=$!; '
            'wait "$LAVALAMP_PID"; STATUS=$?; '
            'sleep 1; '
            'kill "$TAIL_PID" 2>/dev/null || true; '
            'wait "$TAIL_PID" 2>/dev/null || true; '
            'exit "$STATUS"'
        )
        command = " && ".join(cmd_parts)

        # The compiled CLI cannot read host credentials directly, so copy
        # explicitly supplied Workers AI credentials into the task container.
        cf_id = os.environ.get("CF_ACCOUNT_ID")
        cf_token = os.environ.get("CF_API_TOKEN")

        if cf_id and cf_token:
            creds_json = json.dumps({"accountId": cf_id, "apiToken": cf_token})
            await self.exec_as_agent(
                environment,
                command=(
                    "mkdir -p $HOME/.config/lavalamp && "
                    f"echo {shlex.quote(creds_json)} > $HOME/.config/lavalamp/credentials && "
                    "chmod 600 $HOME/.config/lavalamp/credentials"
                ),
            )

        async def log_agent_output(text: str, stream: str) -> None:
            line = text.rstrip()
            if line:
                self.logger.info("[lavalamp %s] %s", stream, line)

        # Harbor's CLI does not subscribe to raw environment output by default,
        # so mirror streamed chunks into the trial logger explicitly.
        with environment.scoped_output_callback(log_agent_output):
            result = await self.exec_as_agent(
                environment,
                command=command,
            )

        # Preserve the visible text output in Harbor's agent context. The ATIF
        # trajectory is populated separately from the saved session below.
        if result.stdout:
            context.metadata = context.metadata or {}
            context.metadata["final_output"] = result.stdout

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
                    context.metadata = context.metadata or {}
                    context.metadata["error"] = data["error"]
                elif "text" in data:
                    context.metadata = context.metadata or {}
                    context.metadata["final_output"] = data.get("text", "")
                    if "usage" in data:
                        context.metadata["usage"] = data["usage"]
                    if "model" in data:
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
            trajectory = Trajectory(steps=steps)
            trajectory_path = self.logs_dir / "trajectory.json"
            trajectory_path.write_text(
                json.dumps(trajectory.to_json_dict(), indent=2)
            )
            self.logger.info(
                "Built ATIF trajectory with %d steps at %s",
                len(steps),
                trajectory_path,
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
