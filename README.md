# fpl-agent
FPL projection model and daily report for Hold My Tzoli

## Executor (makes the transfers)
`execute.mjs` applies a decision file in `decisions/gwNN.json` to the FPL team: transfers, starting XI, bench order, captain and vice. It never plays a chip, refuses more than one -4 hit whatever the file says, refuses flagged incoming players, and stops within 10 minutes of the deadline. Pushing a decision file runs `.github/workflows/execute.yml`; changes are made only if the file says `"apply": true`. Each run writes `reports/executions/gwNN.json`, and any failure opens a GitHub issue.

Sign-in: run `node tools/fpl-login.mjs` on your own computer (fresh private window, close it straight away). It stores the `FPL_REFRESH_TOKEN` repository secret. FPL rotates the token on every use, so the workflow keeps the latest one in its cache, encrypted with that secret, and checks the sign-in every morning. Repeat the login if the morning check opens an issue, or about every six months.

## Self-review and learning (v1.5)

After every finished, data-checked gameweek, `review.mjs` writes `reports/reviews/gwNN.md` (and `.json`): the score against projection and against normal variance, rank and league movement, and where the points went (lineup, armband, bench, transfers, players who were expected to play and did not, and any departure from the model's last pre-deadline view).

It then refits three things from every stored pre-deadline snapshot: a per-position points calibration, a mapping of the model's probability of playing onto what actually happened, and the weight placed on FPL's own `ep_next`. A change is adopted only when it beats the current model on gameweeks it was not fitted on (leave-one-gameweek-out, needs three finished gameweeks), is shrunk towards no change, and moves a capped step per review. Results go to `model/params.json`, which `fpl.mjs` reads; every change is logged in `model/changelog.md`.

`model/lessons.md` holds automated findings (regenerated each review) and reflections written by the deadline agent on its own judgement calls. The deadline agent reads it before every decision.
