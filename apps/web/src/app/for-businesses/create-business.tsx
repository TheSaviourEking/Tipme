import { ActionLink, Surface } from '@tipme/ui';

/**
 * With TipMe for businesses on (owner's answer, 6 Nov 2026): anyone signed in creates a business.
 * TipMe staff check it before its codes go live, so this never promises a date or approval.
 */
export function CreateBusiness({ signup = false }: { signup?: boolean }) {
  return (
    <Surface material="instrument" className="business-card">
      <div className="business-card__create" data-testid="create-business">
        <p className="business-card__big">Create your business on TipMe.</p>
        <p>
          Add your business and its first location with your own TipMe account.
          Then invite the people who work there.
        </p>
        {/* Business sign-up: the business path of sign-up; signed in with a page, it opens the
            dashboard's form. */}
        <ActionLink
          variant="continue"
          href={signup ? '/sign-up?for=business' : '/dashboard/business/apply'}
        >
          Create your business
        </ActionLink>
      </div>
      <p className="business-card__note">
        TipMe staff check your business’s name, address and contact before its
        codes go live.
      </p>
    </Surface>
  );
}
