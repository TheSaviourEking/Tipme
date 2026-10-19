# Experience engineering and design-system requirements

## Brand
LOCKED: `#7A32F9` purple, `#FFFFFF` white, `#000000` black. PROPOSED: accessible neutral and purple tint scales, tokens for hover/focus/success/error, optional purple gradients. Contrast test all text/control pairings. Logo and fonts require design signoff.

## Four experiences
1. **Marketing**: original editorial storytelling, expressive but measured motion, SEO crawlability, social link preview. Good performance on slow mobile.
2. **Public identity**: human recipient, trustworthy profile, share link and QR, validated state, privacy and reporting. Index only active/approved substantive public profiles.
3. **Checkout**: show full recipient and total, suggested amounts + custom entry, optional private message, guest-first, no account wall or manipulative nudging. Focus and error recovery, idempotent submit, pending/unknown, verified success.
4. **Recipient dashboard**: actual tip and payout states, gross/fees/net clarity, private messages, analytics and QR access; no unsupported 'wallet balance' language.

## Design tokens
Tokens should cover colors, typography, spacing, radius, shadows, stacking, layout grid, motion durations/easings and breakpoints. Document usage and avoid ad hoc hex values in components.

## Motion classes
- Marketing: GSAP selective (only if necessary), progressive enhancement, no scroll-jacking.
- Public profile: minimal reveal/hover motion and meaningful microfeedback.
- Checkout: CSS-based 100-200ms feedback and stable layout; no blocking entrance choreography.
- Success: optional 0.5-1.2s appreciation signature after trusted verification, with reduced motion alternative.
- All interactive controls must work on touch devices without hover.

## Inspiration sources, NOT drop-in standards
https://www.scrolltide.co/ ; https://uiarc.dev/ ; https://annnimate.com/animations ; https://kobra.systems/components/card ; https://bencho.dev/ ; https://vault.hyperiux.com/ ; https://libraries.dev/ ; https://beui.dev/ ; https://www.beautifului.dev/ ; https://uimaxx.ing/#library ; https://magicui.design/docs/components ; https://reactbits.dev/ ; https://ui.aceternity.com/

All third-party components require a row in `docs/third-party-component-register.md` with license, origin, dependency size, a11y, mobile perf, maintained status and adopted customization. Do not indiscriminately install these libraries.

## Responsive and accessible acceptance
- Target 320px wide through large desktop, 200% browser zoom, keyboard-only complete guest tip journey, visible focus.
- Labels/errors programmatically associated; live region for payment status; accessible QR fallback link.
- Respect `prefers-reduced-motion`. No color-only state. No inaccessible canvas-only checkout.
- Forms retain inputs on recoverable errors but must not leak sensitive data into URLs or analytics.

## SEO rules
- Useful public profiles server rendered; unique titles/descriptions and canonical; stable @handle URL design must account for encoded handles and clashes with reserved slugs.
- Private, disabled, unapproved, thin and internal pages noindex; generate sitemap only for eligible public profiles.
- Robots + canonical + redirect tests; open graph previews safe, fast and personalized.
- Track share-to-visit-to-tip with privacy-conscious referral attribution.

## Performance targets (PROPOSED)
Field p75: LCP <=2.0s, INP <=150ms, CLS <=0.05. Budget JS, font weights, hero imagery and third-party scripts; profile and checkout are more important than animation spectacle. Validate in RUM and synthetic mobile tests, no 'Lighthouse 100' theater.
