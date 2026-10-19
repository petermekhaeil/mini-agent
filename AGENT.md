# Working on mini-agent

- Keep changes small. One fix or feature per change; don't refactor nearby code.
- Keep try blocks narrow. Catch only errors the caller can recover from; let unrelated failures propagate.
- For a bug fix, write a test that fails before the fix and passes after.
- Never delete or loosen an assertion to make a test pass. If a test looks wrong, stop and explain.
- edit_file old_str/new_str are raw file text. Don't double-escape backslashes or newlines.
- Use read_file for reading files; use offset and limit for line ranges.
- After code changes run `bun test`, `bunx tsc --noEmit`, and `git diff --check`. Say which checks you couldn't run.
- Show the diff and results before suggesting a commit. Only commit or push when asked.
