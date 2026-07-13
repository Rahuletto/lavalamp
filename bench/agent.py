"""
Harbor agent adapter for lavalamp.

Installs lavalamp (bun + repo) inside a Harbor-managed container and drives it
via the non-interactive print mode (`lavalamp -p "..." --yes --quiet`).

Usage:
    harbor run -d terminal-bench@2.0 \
        --agent bench.agent:LavalampAgent \
        --model cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code
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

# Minimum bun version that lavalamp requires
_BUN_MIN_VERSION = "1.3.14"


class LavalampAgent(BaseInstalledAgent):
    """Harbor adapter for the lavalamp AI coding harness."""

    SUPPORTS_ATIF: bool = False
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
        'export PATH="$HOME/.bun/bin:$PATH"; command -v lavalamp >/dev/null 2>&1'
    )

    @staticmethod
    @override
    def name() -> str:
        return "lavalamp"

    @override
    def get_version_command(self) -> str | None:
        return 'export PATH="$HOME/.bun/bin:$PATH"; lavalamp --version'

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
                'curl -fsSL https://bun.sh/install | bash -s -- '
                f'bun-v{_BUN_MIN_VERSION} && '
                'echo \'export PATH="$HOME/.bun/bin:$PATH"\' >> ~/.bashrc && '
                'export PATH="$HOME/.bun/bin:$PATH" && '
                "bun --version"
            ),
        )

        # Clone and build lavalamp (as agent user)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export PATH="$HOME/.bun/bin:$PATH"; '
                "git clone --depth 1 https://github.com/Rahuletto/lavalamp.git "
                "$HOME/.lavalamp-src && "
                "cd $HOME/.lavalamp-src && "
                "bun install --frozen-lockfile && "
                "bun run build && "
                # Symlink the bin wrapper into PATH
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
        # Build the lavalamp command
        cmd_parts = [
            'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"',
            "cd /workspace",
            "lavalamp -p {prompt} --yes --quiet --output-format json".format(
                prompt=shlex.quote(instruction),
            ),
        ]

        # Pass model if specified
        model = self._resolve_model()
        if model:
            cmd_parts[-1] = (
                "LAVALAMP_MODEL={model} ".format(model=shlex.quote(model))
                + cmd_parts[-1]
            )

        command = " && ".join(cmd_parts)

        result = await self.exec_as_agent(
            environment,
            command=command,
            timeout=self.timeout,
        )

        # Parse JSON output for context/trajectory
        if result.stdout:
            self._parse_output(result.stdout, context)

    def _resolve_model(self) -> str | None:
        """Determine the model to use from CLI flags or env."""
        if self.model_name:
            return self.model_name
        return os.environ.get("LAVALAMP_MODEL")

    def _parse_output(self, stdout: str, context: AgentContext) -> None:
        """Parse lavalamp's JSON output and populate the agent context."""
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
