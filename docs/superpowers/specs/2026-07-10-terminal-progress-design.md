# Terminal Progress Design

Lavalamp emits terminal-native OSC 9;4 indeterminate progress for active headless requests. No percentage is calculated or displayed.

- First active request emits `ESC ] 9 ; 4 ; 3 BEL`.
- Final active request completion, failure, cancellation, shutdown, or synchronous send failure emits `ESC ] 9 ; 4 ; 0 BEL`.
- A process-wide reference count prevents nested or overlapping agent requests from clearing progress early.
- Progress writes to stderr so stdout text and JSON streams remain clean.
- Output requires a TTY, skips `TERM=dumb`, and honors `LAVALAMP_TERMINAL_PROGRESS=0` to disable or `=1` to force.
- Print, REPL, and simple mode wrap their prompt callbacks with the controller.
- Full-screen OpenTUI and its subagents never emit OSC progress. OpenTUI owns its alternate-screen rendering and displays its own waiting/spinner state.

Tests cover indeterminate and clear sequences, nesting, idempotent completion, TTY/environment gates, and force/disable overrides.
