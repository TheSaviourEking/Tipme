import type { Metadata } from 'next';
import { WelcomeView } from './welcome-view';

export const metadata: Metadata = { title: 'Welcome' };

export default function WelcomePage() {
  return <WelcomeView />;
}
