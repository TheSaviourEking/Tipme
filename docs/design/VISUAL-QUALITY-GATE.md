# Visual quality gate

High-fidelity completion requires both automated and human evidence.

## Automated

- Deterministic Playwright screenshots at approved desktop and mobile viewports.
- Axe, keyboard, 320px reflow, reduced-motion, and forced-colors coverage.
- Functional quote, checkout, pending, and verified-success tests remain green.
- Fonts are ready, animations/caret are controlled, and fixture data is stable before capture.

## Human review

- Compare composition, typography, crop, material edges, press states, shadow restraint, and purple concentration with the repository-owned board.
- Review screenshot diffs; never update baselines solely to make CI green.
- Check touch, keyboard, 200% zoom, images/fonts disabled, slow network, and screen-reader smoke.

Baseline changes require an explanation of the intended visual decision. Final parity remains blocked while `reference/tipme-interface-directions.png` is absent.

## Baseline authority

Only an intentional design change may update a screenshot baseline. The author must run the visual spec without update mode first, inspect the produced actual/diff images at desktop and mobile, explain the intended change in the commit, then run with `--update-snapshots`. A reviewer must compare the resulting baseline with this document's anatomy checklist. CI failure alone is never permission to accept a new baseline.
