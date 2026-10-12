# Backlog

- Stream command output with a real memory bound instead of buffering all output before truncating the returned text.
- Isolate commands with process-tree/container controls and filtered credentials; the approved shell currently inherits the environment and descendants may survive its timeout.
- `edit_file` reads and validates the file before approval, then writes its edited snapshot after approval without revalidation; changes made while approval is pending can be overwritten. The target can also be swapped for a symlink or other path after resolution, and a write failure can leave a partial file. Hard-link aliases outside the working directory can expose the same content. Consider safer atomic writes and stronger race handling, without claiming a complete filesystem sandbox. File creation remains unsupported for now.
- Explore search tools, token metering, an interactive REPL, and a Ralph-style repeated agent loop.
