import { Container, Skeleton } from '@tipme/ui';

/** The profile's own silhouette while it loads, so nothing jumps when the person appears. */
export default function Loading() {
  return (
    <main id="main" tabIndex={-1} className="profile-page">
      <Container>
        <div className="profile-stage profile-stage--loading">
          <div className="profile-scene">
            <div className="profile-headline">
              <h1 className="profile-headline__title">Finding your person.</h1>
            </div>
            <div className="profile-portrait">
              <Skeleton label="Loading their page" />
            </div>
          </div>
          <div className="profile-composer tip-instrument">
            <div className="appreciation-card tm-card">
              <Skeleton label="Loading appreciation options" />
            </div>
          </div>
        </div>
      </Container>
    </main>
  );
}
