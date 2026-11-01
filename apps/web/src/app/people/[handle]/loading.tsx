import { Skeleton } from '@tipme/ui';

/** The page's own silhouette while it loads, so nothing jumps when the person appears. */
export default function Loading() {
  return (
    <main id="main" tabIndex={-1} className="profile-page">
      <div className="profile-sheet">
        <div className="profile-cover profile-cover--loading" />
        <div className="profile-columns">
          <div className="profile-identity">
            <div className="profile-identity__head">
              <span className="profile-photo avatar--initials" />
            </div>
            <Skeleton label="Loading their page" />
          </div>
          <div className="profile-composer tip-instrument">
            <div className="appreciation-card tm-card">
              <Skeleton label="Loading appreciation options" />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
