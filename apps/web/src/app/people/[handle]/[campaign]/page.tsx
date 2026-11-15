// Campaign Studio: /@handle/<ending> (rewritten here) is the person's tip page. The browser reads
// the ending from the address and sends it with the visit and the tip. On Pro, with campaign pages
// switched on, a campaign with its own page shows its headline, description and cover above the
// same tip area (the page reads `campaign` from these params); otherwise there is no campaign
// name anywhere on it. A stopped or unknown ending still opens the page, so printed codes never
// break. The canonical address stays /@handle.
import ProfilePage, { generateMetadata } from '../page';

export const instant = false;

export { generateMetadata };
export default ProfilePage;
