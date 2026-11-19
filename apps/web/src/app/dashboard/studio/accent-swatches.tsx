'use client';
import {
  CLASSIC_PURPLE,
  STUDIO_ACCENTS,
  type StudioAccentId,
  type StudioStyleId,
} from '@tipme/contracts';
import { ICONS, RadioGroup } from './segmented';
import { accentChoices } from './style-tab-model';

/**
 * The accent swatches (§10.3; canvas "Choosing a style"): 33 px circles, gap 7 (40 and 12 on a
 * desktop), wrapping, each named. TipMe purple comes first on Classic. The selected one has a
 * 3 px white + 5 px #141210 ring and a check. "From your photo" is a cone of the photo's colours,
 * aria-disabled with a lock on Free (and on Pro without a profile photo), its reason in `noteId`.
 */
export function AccentSwatches({
  styleId,
  value,
  plan,
  hasAvatar,
  labelledBy,
  noteId,
  onChange,
  readOnly,
}: {
  styleId: StudioStyleId;
  /** The swatch shown selected (`selectedAccent`): null is TipMe purple. */
  value: StudioAccentId | null;
  plan: 'free' | 'pro';
  hasAvatar: boolean;
  labelledBy: string;
  noteId: string;
  onChange(accent: StudioAccentId | null): void;
  readOnly: boolean;
}) {
  const choices = accentChoices(styleId, plan, hasAvatar);
  return (
    <RadioGroup
      labelledBy={labelledBy}
      items={choices.map((c) => ({
        value: c.value,
        key: c.value ?? 'tipme-purple',
        label: c.name,
        disabled: c.disabled,
        ...(c.value === 'photo' ? { describedBy: noteId } : {}),
      }))}
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      className="pst-swatches"
      itemClassName="pst-swatch"
      render={(item, checked) => {
        const choice = choices.find((c) => c.value === item.value)!;
        return (
          <span
            className="pst-swatch__dot"
            data-photo={choice.fill === null || undefined}
            style={
              choice.fill
                ? {
                    background: choice.fill,
                    // The check in the accent's own label colour (Amber's is dark).
                    color:
                      choice.value === null
                        ? CLASSIC_PURPLE.light.label
                        : choice.value === 'photo'
                          ? '#ffffff'
                          : STUDIO_ACCENTS[choice.value].light.label,
                  }
                : undefined
            }
          >
            {checked
              ? ICONS.check(18)
              : choice.disabled && choice.fill === null
                ? ICONS.lock
                : null}
          </span>
        );
      }}
    />
  );
}
