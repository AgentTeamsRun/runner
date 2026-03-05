# @rlarua/agentrunner

A background runner that polls and executes AI agent tasks from the AgentTeams platform.

## Prerequisites

- Node.js `18` or later
- AgentTeams API server running
- A daemon token issued from the web UI (`x-daemon-token`)

## Installation

```bash
npm install -g @rlarua/agentrunner
```

Verify the installation:

```bash
agentrunner --help
```

## Quick Start

### 1. Initialize

```bash
agentrunner init --token <DAEMON_TOKEN>
```

The `init` command:

1. Saves the token to `~/.agentteams/daemon.json`
2. Validates the token against the API server
3. Registers an OS-level autostart service and starts the runner immediately
   - **macOS**: `~/Library/LaunchAgents/run.agentteams.daemon.plist` (launchd)
   - **Linux**: `~/.config/systemd/user/agentrunner.service` (systemd)
   - **Windows**: `AgentRunner` (Task Scheduler)

### Options

- `--token <token>` — **Required**. Daemon token issued from the web UI
- `--no-autostart` — Optional. Skip autostart registration (manual start only)

Examples:

```bash
# Standard setup (with autostart)
agentrunner init --token daemon_xxxxx

# Token-only setup (no autostart)
agentrunner init --token daemon_xxxxx --no-autostart
```

### 2. Start (`start`)

```bash
agentrunner start
```

Running without a subcommand defaults to `start`:

```bash
agentrunner
```

> If autostart was registered via `init`, you do not need to run `start` manually.
> The OS will start the runner automatically on login/boot.

### 3. Check Status (`status`)

```bash
agentrunner status
```

Shows whether the runner process is active and whether autostart is registered.

Example output:

```
[...] INFO Daemon is running { pid: 12345 }
[...] INFO Autostart is enabled { platform: 'launchd' }
```

### 4. Stop (`stop`)

```bash
agentrunner stop
```

Sends SIGTERM to the running process for a graceful shutdown.

> If autostart is registered, the OS may restart the runner automatically.
> Use `uninstall` to stop completely.

### 5. Uninstall (`uninstall`)

```bash
agentrunner uninstall
```

Performs the following:

1. Stops the running process
2. Removes the autostart service and deletes the service file
3. Cleans up the PID file

## Configuration

Settings are resolved in the following priority order at runtime.

### Token

1. `AGENTTEAMS_DAEMON_TOKEN` environment variable
2. `daemonToken` in `~/.agentteams/daemon.json`

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `POLLING_INTERVAL_MS` | `30000` (30s) | Polling interval for pending triggers |
| `TIMEOUT_MS` | `1800000` (30min) | Runner process timeout |
| `RUNNER_CMD` | `opencode` | Command used to execute agent tasks |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `DAEMON_VERBOSE_RUNNER_LOGS` | `true` | When `false`, reduces runner stdout/stderr to start/stop/error only |
| `DAEMON_PROMPT_LOG_MODE` | `preview` | Prompt logging: `off`, `length`, `preview`, `full` |

## How It Works

After `start`, the runner operates in the following loop:

1. Polls for pending triggers periodically
2. Claims a trigger
3. Fetches runtime info (working directory, API key)
4. Executes `RUNNER_CMD run "<prompt>"`
5. Updates trigger status based on exit code or timeout

If a process is already running for the same `agentConfigId`, new triggers are `REJECTED`.

## Logs

- **Runner logs**: console output (forwarded to OS log system when autostarted)
  - **macOS**: `/tmp/agentrunner.log`, `/tmp/agentrunner-error.log`
  - **Linux**: `journalctl --user -u agentrunner -f`
  - **Windows**: Event Viewer → Windows Logs → Application (`AgentRunner`)
- **Task logs**: `<workdir>/.agentteams/daemonLog/daemon-<triggerId>.log`

## Troubleshooting

### `Missing token. Usage: agentrunner init --token <token> ...`

The `--token` flag was not provided to `init`.

### `Daemon token is missing. Run 'agentrunner init --token <token>' first.`

No token found at runtime. Run `init` first or set the `AGENTTEAMS_DAEMON_TOKEN` environment variable.

## License

Apache-2.0
