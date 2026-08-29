# v2.0.0-beta.4

- Installing a scoped library now pins you to the beta line. `latest` resolves to a 2.0 beta, so
  `npm i @gaunt-sloth/core` — or `agent`, `review`, `batch` — writes `^2.0.0-beta.N` into your
  manifest, and that range admits every later prerelease of the same `2.0.0` version, including the
  breaking changes still permitted on this line. Pin an exact version if you would rather move
  deliberately. Installing the CLI globally is unaffected: `npm i -g gaunt-sloth` writes no manifest.
