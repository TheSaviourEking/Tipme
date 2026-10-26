# TipMe Physical Interface Design Specification

**Date:** 25 October 2026  
**Status:** APPROVED creative direction; implementation remains subject to repository product, accessibility, performance, privacy, and financial invariants  
**Primary reference:** the three-column TipMe interface board supplied by the product owner

## Reference custody

The board is visible in the originating design conversation but is not yet stored in the repository. Before visual baselines are approved, the original image must be added as `docs/design/reference/tipme-interface-directions.png` with a companion README recording its source, date, intrinsic dimensions, and role as art direction rather than a literal responsive layout. Until that asset is present, agents may implement this written anatomy but must not claim final board parity.

## Creative thesis

Make appreciation tangible.

TipMe should feel like a carefully engineered personal object: clean enough to trust with money, tactile enough to invite touch, editorial enough to feel human, and playful only when appreciation deserves a memorable response.

The reference board is the fidelity target. It is not permission to copy decorative details that conflict with real product states, responsive behavior, accessibility, performance, or server-authoritative payment outcomes.

## Direction hierarchy

- **60% Physical Interface:** material construction, control geometry, edge definition, restrained depth, tactile state changes, and the spatial relationship between recipient identity and tipping controls.
- **30% Editorial Interface:** photographic focus, composed typography, asymmetry, whitespace, concise copy, and strong content hierarchy.
- **10% Playful Interface:** signature appreciation acknowledgement, carefully constrained dimensional brand objects, and delightful transitions at meaningful moments.

The percentages express emphasis. TipMe remains one coherent system.

## Reference anatomy

### Desktop

- A quiet warm-white canvas supports one strong composition rather than a dashboard grid.
- Recipient identity and tipping controls are paired but remain distinct physical objects.
- The recipient is the visual anchor: portrait, name, handle, role, short story, and compact interests.
- The tipping panel has clear amount keys, a recessed custom amount field, an optional message, and one unmistakable primary action.
- Purple is concentrated in selection and the primary action, not spread across every surface.
- Fine borders, top-edge highlights, controlled ambient shadows, and contact shadows create shallow depth.
- Typography supplies most personality. Decorative objects never compete with identity or financial clarity.

### Mobile

- The page reads as one composed physical object rather than a desktop layout stacked mechanically.
- Portrait, identity, story, tags, amount controls, message, and action form a deliberate sequence.
- Controls remain at least 44 by 44 CSS pixels and work without hover.
- The primary action remains easy to reach without becoming a permanently obscuring overlay.
- Financial disclosure and payment state remain fully visible.

### Detail language

- Surfaces use believable shallow depth rather than glass or glow.
- Corners are engineered by role: controls, structural cards, and true pills use distinct geometry.
- Pressed controls move toward the canvas and lose elevation; selected controls gain purple material and a precise inner edge.
- Photography or fictional-demo portraiture uses consistent lighting, crop, and art direction.
- Brand symbols are compact, geometric, and optically balanced. Unicode glyphs are not the final visible icon system.

## Material system

### Canvas

The page background is a luminous neutral, visually warmer than pure white but neutral enough for photography and accessible text. It has no floating gradient decoration.

### Raised

Cards, amount keys, and primary controls use a thin light-facing edge, subtle border, shallow contact shadow, and restrained ambient shadow. Raised elements remain legible when shadows are unavailable.

### Recessed

Inputs, quote wells, and selected containers may use an inset edge and a small internal shadow. Recessed surfaces must not resemble disabled controls.

### Signature

The locked purple `#7A32F9` is reserved for primary actions, selection, focus, and the confirmed appreciation moment. Signature surfaces may use a restrained tonal shift needed to describe curvature, but not arbitrary purple-blue gradients.

## Geometry

- Compact controls: 8–12px corner radius.
- Inputs and amount keys: 12–16px corner radius.
- Structural cards and portrait frames: 20–30px corner radius depending on scale.
- Pills: tags, segmented controls, and small statuses only.
- Circles: avatars, knobs, or semantically circular controls only.
- Layout spacing uses a 4px base with an 8px primary rhythm.

## Typography

- **Interface:** crisp contemporary grotesk for controls, labels, copy, and product information.
- **Editorial:** high-contrast serif for selected headlines, quotations, and human emphasis.
- **Numeric:** tabular figures, stable widths, and unambiguous currency presentation.

Implementation must evaluate rendering, license, weight count, loading, fallback metrics, and Nigerian currency glyph quality before adopting exact faces. This resolves D-09 only when evidence supports approval.

Headlines are composed, not merely enlarged. Line breaks are intentional at flagship breakpoints and robust with longer names.

## Color

Locked colors remain `#7A32F9`, `#FFFFFF`, and `#000000`. Supporting neutrals and semantic colors require named tokens. Component code must not introduce ad hoc presentational hex values. State is always communicated by more than color alone.

## Control behavior

### Buttons

- Rest: raised, crisp edge, legible label.
- Hover: small lighting/elevation change only on hover-capable devices.
- Pressed: 1–2px displacement and reduced shadow.
- Focus: high-contrast external ring that is never clipped.
- Busy: stable dimensions, clear progress copy, no fake success.
- Disabled: reduced emphasis with readable contrast.

### Amount keys

- Operate as a native radio group.
- Selected state is purple, visually and programmatically distinct.
- Arrow-key behavior and wrapping remain intact.
- Custom amount reveals a recessed currency field without layout instability.

### Fields

- Labels remain visible; hints and errors remain programmatically connected.
- Focus, invalid, disabled, and populated states are separately identifiable.
- Financial information is never represented only by placeholder text.

## Motion

- Immediate tactile response: 100–180ms.
- Component transition: 180–320ms.
- Spatial/editorial transition: 320–500ms.
- Verified appreciation acknowledgement: 500–900ms, then settles.

Motion communicates pressure, continuity, confirmation, or hierarchy. It does not delay content, move controls away from the pointer, or simulate a financial result. Reduced-motion users receive an immediate, equally expressive static state.

## TipMe Appreciation Moment

The signature moment starts only after backend-confirmed `paid` is rendered. It is shown for every trusted paid result. Optional locally remembered recognition/history copy is a separate enhancement and never gates the confirmed composition.

- The physical card settles into a confirmed state.
- A compact TipMe symbol and restrained purple acknowledgement appear.
- Recipient name and exact confirmed amount remain readable.
- The moment is warm and personal, never competitive or guilt-driven.
- Pending, checking, declined, cancelled, unknown, offline, and delayed states never borrow success styling.
- Reduced-motion users receive the final composition without choreography.

## Surface personalities

- **Marketing:** most editorial and expressive; based on the same materials and type system.
- **Public profile:** brand-defining synthesis and first flagship implementation.
- **Tipping and receipt:** highest clarity and trust; material detail supports financial information.
- **Dashboard and operations:** quieter and denser; typography, alignment, and state clarity dominate.

## Component ownership

- `packages/ui` owns semantic tokens, materials, typography roles, symbols, and reusable accessible primitives.
- `apps/web` owns product composition, recipient data, checkout behavior, route states, and page-specific layout.
- No second UI package or styling framework is introduced.
- Application components may compose shared primitives but must not duplicate their state styling.

## Accessibility and resilience

- WCAG 2.2 AA intent remains mandatory.
- The guest tipping journey works with keyboard, touch, screen reader, 320px viewport, 200% zoom, and reduced motion.
- Visible targets are at least 44 by 44 CSS pixels unless an equivalent larger interactive area exists.
- Focus is visible against every material; forced colors preserve borders, selection, focus, and state.
- Content remains understandable with images, fonts, animation, or shadows unavailable.
- Longer names, biographies, large currency values, loading, errors, offline state, and provider delay do not break composition.

## Performance and privacy

- Preserve public-profile LCP and client-bundle discipline.
- Prefer CSS material effects and authored SVG over runtime 3D or animation libraries.
- New fonts and images require measured budgets and optimized loading.
- No payer-sensitive content or private message enters screenshots, metadata, URLs, logs, or analytics.

## Visual quality gate

High-fidelity completion requires:

1. Deterministic desktop and mobile screenshots for the design system, profile, selected amount, quote, validation error, pending, and verified success.
2. Reviewed baselines with an explicit update procedure.
3. Browser inspection at 320px, 360px, tablet, standard desktop, and wide desktop.
4. Axe, keyboard, reflow, reduced-motion, and checkout checks.
5. Manual review of typography, cropping, physical states, shadow restraint, and parity with the board.
6. No claim of fidelity based solely on token values or component snapshots.

## Out of scope for the flagship slice

- Payment-provider or financial-state behavior changes.
- Real payment activation.
- Wholesale dashboard or operations redesign.
- Runtime WebGL, physics engines, or decorative 3D dependencies.
- New product features outside the public profile and tipping flow.
