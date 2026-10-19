import { Container, Skeleton } from '@tipme/ui';
export default function Loading() {
  return (
    <main id="main" tabIndex={-1}>
      <Container className="section-space">
        <h1 className="page-title">Finding your person.</h1>
        <div className="profile-grid">
          <Skeleton label="Loading profile identity" />
          <Skeleton label="Loading appreciation options" />
        </div>
      </Container>
    </main>
  );
}
