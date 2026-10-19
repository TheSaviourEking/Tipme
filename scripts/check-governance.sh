#!/usr/bin/env bash
set -euo pipefail
for f in AGENTS.md docs/00-DECISIONS.md docs/01-LOCAL-SETUP.md docs/03-DOMAIN-AND-PAYMENTS.md apps/web/AGENTS.md apps/api/AGENTS.md apps/worker/AGENTS.md packages/ui/AGENTS.md packages/contracts/AGENTS.md; do
  if [[ ! -s "$f" ]]; then echo "Missing governance file: $f" >&2; exit 1; fi
done
if grep -R -q -E 'sk_live_[[:alnum:]]{8,}|pk_live_[[:alnum:]]{8,}' --include='*.env' --include='.env.*' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=.turbo . 2>/dev/null; then
  echo 'Potential live payment key in tracked/dev files. Inspect immediately.' >&2; exit 1
fi
echo 'Governance files present. This is NOT a full secret scan or release validation.'
