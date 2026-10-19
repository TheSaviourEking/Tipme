import Link from 'next/link';
import { ActionLink, Container } from '@tipme/ui';
export default function NotFound() {
  return (
    <main id="main" tabIndex={-1}>
      <Container className="unavailable-page">
        <span className="large-flower" aria-hidden="true">
          ✳
        </span>
        <p className="eyebrow">A little detour</p>
        <h1>This profile isn’t available.</h1>
        <p>
          The link may be incorrect, or the page may no longer be here.
          <br />
          You can still explore one of our fictional demo profiles.
        </p>
        <ActionLink href="/@ada">Explore Ada’s demo profile</ActionLink>
        <Link className="text-link" href="/">
          Back to TipMe
        </Link>
      </Container>
    </main>
  );
}
