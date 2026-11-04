'use client';
import type { MyProfile } from '@tipme/contracts';
import { LayerView, type Layer } from '@/components/account/cover-settings';
import { AvatarImage } from '@/components/avatar';
import { hasAvatar } from '@/lib/avatar-source';
import { formatNaira } from '@/lib/demo-amount';
import { amountOptions } from '@/lib/tip-amounts';
import type { AboutForm } from './my-page';

/**
 * "What supporters see" (ScreenSettings): the page as a phone shows it, drawn from what is typed
 * now, saved or not. It saves nothing; Save changes does. The amounts are the page's own, as the
 * API sends them (the standard ones on Free), and the selected one is where the page starts.
 */
export function PagePreview({
  profile,
  about,
  cover,
}: {
  profile: MyProfile;
  about: AboutForm;
  cover: Layer | null;
}) {
  const name = about.displayName.trim() || profile.handle;
  const firstName = name.split(/\s+/)[0] ?? name;
  const options = amountOptions(profile.tipAmounts);
  const start = options.defaultMinor;
  const photo = profile.avatarPath ?? null;
  return (
    <aside aria-label="Live preview of your page" className="settings-preview">
      <p className="settings-preview__caption">What supporters see</p>
      <div className="settings-preview__phone">
        <div className="settings-preview__cover" aria-hidden="true">
          {cover && <LayerView layer={cover} />}
        </div>
        <div className="settings-preview__body">
          <span className="settings-preview__photo" aria-hidden="true">
            {hasAvatar(photo) ? (
              <AvatarImage
                src={photo}
                name={name}
                width={96}
                height={96}
                sizes="96px"
              />
            ) : (
              <span className="avatar--initials">
                {Array.from(name)[0]?.toUpperCase()}
              </span>
            )}
          </span>
          <p className="settings-preview__name">{name}</p>
          <p className="settings-preview__handle">@{profile.handle}</p>
          {about.role.trim() && (
            <p className="settings-preview__role">{about.role}</p>
          )}
          {about.bioPublic && about.bio.trim() && (
            <p className="settings-preview__bio">{about.bio}</p>
          )}
          <div className="settings-preview__tip">
            <p className="settings-preview__tip-title">Tip {firstName}</p>
            <ul className="settings-preview__keys" aria-label="Amounts">
              {options.presets.map((preset) => (
                <li
                  key={preset.minor}
                  data-selected={preset.minor === start || undefined}
                >
                  {formatNaira(preset.minor)}
                </li>
              ))}
            </ul>
            {start !== null && (
              <p className="settings-preview__go">Tip {formatNaira(start)}</p>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
