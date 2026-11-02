'use client';
import { useId } from 'react';
import {
  OPS_CATALOGUE,
  OPS_PERMISSION_GROUPS,
  OPS_PERMISSIONS,
  SERIOUS_ACTION_PERMISSIONS,
  type OpsPermission,
} from '@tipme/contracts';
import { Badge, Notice } from '@tipme/ui';

const GROUP_WORDS: Record<(typeof OPS_PERMISSION_GROUPS)[number], string> = {
  money: 'Money',
  people: 'People',
  content: 'Issues and email',
  numbers: 'Numbers and records',
  settings: 'Settings',
};

const SERIOUS = new Set<string>(Object.values(SERIOUS_ACTION_PERMISSIONS));

/** Permissions by group, sensitive and second-person ones marked. Warns once one is ticked. */
export function PermissionPicker({
  ticked,
  onChange,
  held,
  differs,
}: {
  ticked: readonly string[];
  onChange: (next: string[]) => void;
  /** What the person using this holds: nobody can give what they don't have. */
  held: readonly string[];
  /** For a person: how a permission differs from their role. */
  differs?: (permission: string) => string | null;
}) {
  const id = useId();
  const sensitive = ticked.filter(
    (p) => OPS_CATALOGUE[p as OpsPermission]?.sensitive,
  );
  return (
    <div className="ops-picker">
      {OPS_PERMISSION_GROUPS.map((group) => (
        <fieldset key={group}>
          <legend>{GROUP_WORDS[group]}</legend>
          {OPS_PERMISSIONS.filter((p) => OPS_CATALOGUE[p].group === group).map(
            (permission) => {
              const entry = OPS_CATALOGUE[permission];
              const on = ticked.includes(permission);
              const note = differs?.(permission);
              return (
                <label
                  key={permission}
                  className="ops-picker__row"
                  htmlFor={`${id}-${permission}`}
                >
                  <input
                    id={`${id}-${permission}`}
                    type="checkbox"
                    checked={on}
                    // Taking one off is always allowed, as the server allows it.
                    disabled={!on && !held.includes(permission)}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...ticked, permission]
                          : ticked.filter((p) => p !== permission),
                      )
                    }
                  />
                  <span>
                    <code>{permission}</code> {entry.description}
                    {entry.sensitive && <Badge> Sensitive</Badge>}
                    {SERIOUS.has(permission) && <Badge> Second person</Badge>}
                    {note && <em> {note}</em>}
                  </span>
                </label>
              );
            },
          )}
        </fieldset>
      ))}
      {sensitive.length > 0 && (
        <Notice tone="neutral" title="You’ve ticked sensitive access">
          {sensitive.join(', ')}: moving or settling money, reading private
          details, or changing accounts and settings. When someone else can
          approve, giving this waits for them.
        </Notice>
      )}
    </div>
  );
}
