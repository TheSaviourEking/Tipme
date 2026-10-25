#!/usr/bin/env bash
set -euo pipefail
for f in AGENTS.md docs/00-DECISIONS.md docs/01-LOCAL-SETUP.md docs/03-DOMAIN-AND-PAYMENTS.md apps/web/AGENTS.md apps/api/AGENTS.md apps/worker/AGENTS.md packages/ui/AGENTS.md packages/contracts/AGENTS.md docs/design/DESIGN-CONSTITUTION.md docs/design/REFERENCE-ANATOMY.md docs/design/TOKENS-AND-MATERIALS.md docs/design/TYPOGRAPHY.md docs/design/COMPONENT-STANDARDS.md docs/design/MOTION-AND-APPRECIATION.md docs/design/RESPONSIVE-COMPOSITION.md docs/design/ICONOGRAPHY.md docs/design/VISUAL-QUALITY-GATE.md docs/design/DECISION-LOG.md; do
  if [[ ! -s "$f" ]]; then echo "Missing governance file: $f" >&2; exit 1; fi
done
constitution='docs/design/DESIGN-CONSTITUTION.md'
if ! grep -q '60% Physical Interface' "$constitution" || ! grep -q '30% Editorial Interface' "$constitution" || ! grep -q '10% Playful Interface' "$constitution" || ! grep -qi '#7A32F9' "$constitution" || ! grep -qi '#FFFFFF' "$constitution" || ! grep -qi '#000000' "$constitution"; then
  echo 'Design constitution is missing the approved direction or locked palette.' >&2; exit 1
fi
for f in AGENTS.md apps/web/AGENTS.md packages/ui/AGENTS.md; do
  if ! grep -q 'docs/design/DESIGN-CONSTITUTION.md' "$f"; then
    echo "Missing design authority instruction: $f" >&2; exit 1
  fi
done
if grep -R -q -E 'sk_live_[[:alnum:]]{8,}|pk_live_[[:alnum:]]{8,}' --include='*.env' --include='.env.*' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=.turbo . 2>/dev/null; then
  echo 'Potential live payment key in tracked/dev files. Inspect immediately.' >&2; exit 1
fi
echo 'Governance files present. This is NOT a full secret scan or release validation.'
