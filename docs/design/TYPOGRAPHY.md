# Typography

Typography has interface, editorial, brand, and numeric roles.

- Interface: crisp grotesk for controls, labels, and body copy.
- Editorial: high-contrast serif for selected headlines and human emphasis.
- Brand: compact heavy wordmark treatment.
- Numeric: tabular figures and stable currency widths.

The current provisional pairing is Manrope for interface/body text and DM Serif Display for editorial emphasis; the TipMe wordmark is the master SVG, not type. Both fonts are loaded through `next/font` at build time with `font-display: swap`; browsers make no runtime font request. Manrope is bounded to 400–700, DM Serif Display to 400,. These Google Fonts are distributed under the SIL Open Font License 1.1 and include the Naira sign used by the product.

Exact typeface approval remains open under D-09 until rendered desktop/mobile specimens are approved. The fallback stack uses Avenir Next/Arial for interface text and Iowan Old Style/Georgia for editorial text. Review must include font-disabled rendering, long names, currency alignment, and 200% zoom before D-09 can close.
