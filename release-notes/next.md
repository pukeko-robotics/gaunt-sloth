# v2.3.1

- `gth pr` and `gth review` now write their report file, naming the error, when a `--file` cannot be read or the requirements source cannot be resolved, instead of crashing without one.
- `gth pr` and `gth review` can now fetch a pull request whose diff is larger than 1 MiB. It no longer fails with "stdout maxBuffer length exceeded", and the GitHub issue and file reads get the same fix.
