import PrintCardPage from './print-view';

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell),
// so this segment has nothing to prerender for instant navigation.
export const instant = false;

export default PrintCardPage;
