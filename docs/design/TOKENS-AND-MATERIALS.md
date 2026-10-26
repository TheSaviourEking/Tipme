# Tokens and materials

`packages/ui/src/tokens.css` is the code authority. Components consume semantic roles rather than raw decorative values.

## Materials

- **Canvas:** luminous warm neutral; stable and nearly flat.
- **Raised:** light-facing edge, subtle border, shallow contact shadow, restrained ambient shadow.
- **Recessed:** inset edge and minimal internal shade; never confused with disabled.
- **Signature:** locked purple for primary action, selection, focus, and verified acknowledgement.

## Geometry

- Compact controls: 8–12px.
- Fields and amount keys: 12–16px.
- Structural cards: 20–30px.
- Pills only for tags, segmented controls, and compact status.

## Motion roles

- Tactile: 100–180ms.
- Component: 180–320ms.
- Spatial: 320–500ms.
- Verified acknowledgement: 500–900ms, then settles.

New tokens require a specimen, accessibility review, and a decision-log entry when they introduce a new role.
