# Component standards

`packages/ui` owns reusable state styling; `apps/web` owns product composition and data.

## Required states

Interactive primitives expose rest, hover where supported, pressed, focus-visible, busy, disabled, selected, invalid, and forced-colors behavior. Visible targets are at least 44px. Labels, hints, and errors remain programmatically associated.

## Physical behavior

Raised actions lose elevation and move 1–2px toward the canvas when pressed. Selected amount keys use signature material plus a non-color indication. Inputs are recessed without appearing unavailable. Focus rings sit outside the material and are never clipped.

## Boundaries

Shared UI never imports app finance logic. App components may compose primitives but do not reproduce their state CSS. Do not create a second UI package or add a component framework.
