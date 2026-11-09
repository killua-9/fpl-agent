# Model changelog

Every learnt parameter change, newest first. Changes are adopted only if they beat the current model on gameweeks they were not fitted on, and move at most a fixed step per review.

## params v3, 2026-11-09 (after GW10)

Validation over 3 gameweeks: out-of-sample MAE 1.92 raw vs 1.9 calibrated; minutes Brier 0.1932 vs 0.1504.

- GK points calibration a 0->0.03, b 1->1 (n 64)
- DEF points calibration a 0->0.1, b 1->0.99 (n 344)
- MID points calibration a 0->0.2, b 1->0.92 (n 456)
- FWD points calibration a 0->0.05, b 1->1 (n 103)
- minutes calibration knots [[0,0],[0.18,0.45],[0.44,0.69],[0.72,0.79],[0.98,0.96],[1,0.98]]
- ep_next blend weight 0.2->0.16 (least squares 0.08, n 359)

## params v2, 2026-11-03 (after GW9)

Validation over 2 gameweeks: needs 3 finished gameweeks, has 2.

No change adopted.

## params v1, 2026-11-03 (after GW8)

Validation over 1 gameweeks: needs 3 finished gameweeks, has 1.

No change adopted.
