# fpl-agent
FPL projection model and daily report for Hold My Tzoli

## Executor (makes the transfers)
`execute.mjs` applies a decision file in `decisions/gwNN.json` to the FPL team: transfers, starting XI, bench order, captain and vice. It never plays a chip, refuses more than one -4 hit whatever the file says, refuses flagged incoming players, and stops within 10 minutes of the deadline. Pushing a decision file runs `.github/workflows/execute.yml`; changes are made only if the file says `"apply": true`. Each run writes `reports/executions/gwNN.json`, and any failure opens a GitHub issue.

Sign-in: run `node tools/fpl-login.mjs` on your own computer (fresh private window, close it straight away). It stores the `FPL_REFRESH_TOKEN` repository secret. FPL rotates the token on every use, so the workflow keeps the latest one in its cache, encrypted with that secret, and checks the sign-in every morning. Repeat the login if the morning check opens an issue, or about every six months.
