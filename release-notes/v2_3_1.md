# v2.3.1

- `gth pr` and `gth review` now write their report file, naming the error, when a `--file` cannot be read or the requirements source cannot be resolved, instead of crashing without one.
- `gth pr` and `gaunt-sloth-review` can now review a pull request of more than 300 files, or one too large for the model's context. They list the files through the GitHub API, leave out removed, generated and oversized files, and name each file left out. The new `commands.pr.elidePatterns` setting chooses which files are left out.
- On a pull request too large to show whole, `gth pr`, `gth review` and `gaunt-sloth-review` now tell the model the pull request is very large and give it a new `gth_gh_read_file_diff` tool, which reads the diff of any one changed file, sized to fit the model's context, or lists the changed files matching a pattern. Paths with parentheses work. Configure it under `builtInTools`. The review's scoring step now fits the context too.
- `gth pr` and `gth review` can now fetch a pull request whose diff is larger than 1 MiB. It no longer fails with "stdout maxBuffer length exceeded", and the GitHub issue and file reads get the same fix.
