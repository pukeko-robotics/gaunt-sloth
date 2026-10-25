# v2.3.1

- `gth pr` and `gth review` now write their report file, naming the error, when a `--file` cannot be read or the requirements source cannot be resolved, instead of crashing without one.
- `gth pr` and `gaunt-sloth-review` can now review a pull request of more than 300 files, or one too large for the model's context. They list the files through the GitHub API, leave out removed, generated and oversized files, and name each file left out. The new `commands.pr.elidePatterns` setting chooses which files are left out.
- `gth pr` and `gth review` can now fetch a pull request whose diff is larger than 1 MiB. It no longer fails with "stdout maxBuffer length exceeded", and the GitHub issue and file reads get the same fix.
