import {
  automaticColour,
  automaticCover,
  COVER_ANIMATIONS,
  COVER_COLOURS,
  COVER_DESIGNS,
  resolveCover,
  type CoverMotion,
  type PagePlan,
  type CoverDesignChoice,
  type MyProfile,
  type ResolvedCover,
} from '@tipme/contracts';

// What the cover chooser holds while someone is choosing (design spec §6). Kept free of React so
// the fallbacks can be tested on their own: the saved choice may name a design or colour the
// catalogue has since dropped, and the chooser must still open on something sensible.

export interface CoverDraft {
  /** The chosen design, or null when nothing has been chosen (TipMe picks one). */
  design: string | null;
  colour: string;
  /**
   * An animated cover (owner's decision, 2 Nov 2026), which replaces `design`. The three fields
   * are present only while one is chosen. `animationColour` is null for the animation's own
   * palette; only Pro pages can pick another.
   */
  animation?: string | null;
  motion?: CoverMotion;
  animationColour?: string | null;
}

const NEUTRAL = 'neutral';

export const takesColours = (design: string | null): boolean =>
  COVER_DESIGNS.some((d) => d.id === design && d.colours);

/** The draft a saved choice opens as. Unknown designs and colours fall back quietly. */
export function draftFromChoice(choice: MyProfile['coverChoice']): CoverDraft {
  if (COVER_ANIMATIONS.some((a) => a.id === choice?.animation)) {
    const known = COVER_COLOURS.some((c) => c.id === choice?.colour);
    return {
      design: null,
      colour: NEUTRAL,
      animation: choice?.animation ?? null,
      motion: choice?.motion === 'loop' ? 'loop' : 'once',
      animationColour: known && choice?.colour ? choice.colour : null,
    };
  }
  const design = COVER_DESIGNS.some((d) => d.id === choice?.design)
    ? (choice?.design ?? null)
    : null;
  const known = COVER_COLOURS.some((c) => c.id === choice?.colour);
  return {
    design,
    colour:
      design && takesColours(design) && known && choice?.colour
        ? choice.colour
        : NEUTRAL,
  };
}

/**
 * The request body that saves a draft. No design saves `design: null`: TipMe picks one again. An
 * animation sends its motion and colour only for a Pro page; the server refuses them from Free.
 */
export function choiceBody(draft: CoverDraft, pro = false): CoverDesignChoice {
  if (draft.animation)
    return {
      design: null,
      animation: draft.animation,
      ...(pro && draft.motion ? { motion: draft.motion } : {}),
      ...(pro && draft.animationColour
        ? { colour: draft.animationColour }
        : {}),
    };
  if (!draft.design) return { design: null };
  return takesColours(draft.design)
    ? { design: draft.design, colour: draft.colour }
    : { design: draft.design };
}

/** What the page would show for the draft when no photo is uploaded. */
export function draftPreview(
  draft: CoverDraft,
  handle: string,
  plan?: PagePlan,
): ResolvedCover {
  return resolveCover({
    handle,
    coverPath: null,
    coverDesign: draft.design,
    coverColour: draft.animation
      ? (draft.animationColour ?? null)
      : takesColours(draft.design)
        ? draft.colour
        : null,
    coverAnimation: draft.animation ?? null,
    coverMotion: draft.animation ? (draft.motion ?? null) : null,
    ...(plan ? { plan } : {}),
  });
}

/** Two drafts are the same when they would save the same thing. */
export const sameDraft = (a: CoverDraft, b: CoverDraft): boolean =>
  JSON.stringify(choiceBody(a, true)) === JSON.stringify(choiceBody(b, true));

/** The automatic pick in words ("Rising hearts in Violet"), so the chooser never relies on colour alone. */
export function automaticLabel(handle: string): string {
  const design = COVER_DESIGNS.find((d) => d.id === automaticCover(handle));
  const colour = COVER_COLOURS.find((c) => c.id === automaticColour(handle));
  return [design?.name, colour && `in ${colour.name}`]
    .filter(Boolean)
    .join(' ');
}
