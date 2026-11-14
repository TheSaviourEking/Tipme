// Campaign Studio: /@handle/<ending> (rewritten here) is the person's normal tip page, with no
// campaign name anywhere on it; the browser reads the ending from the address and sends it with
// the visit and the tip only. A stopped or unknown ending still opens the page, so printed codes
// never break. The canonical address stays /@handle.
import ProfilePage, { generateMetadata } from '../page';

export const instant = false;

export { generateMetadata };
export default ProfilePage;
