/** Marketing pieces shared by the home page and the PRD marketing routes. */
import { ModeText } from './payment-mode-slot';

/** The three steps of a tip, in order. */
export function HowItWorksSteps() {
  return (
    <ol className="steps">
      <li>
        <span>01</span>
        <h3>Find your person.</h3>
        <p>
          Open their personal link. Recognize the face, the work, the care that
          brought you here.
        </p>
      </li>
      <li>
        <span>02</span>
        <h3>Make it yours.</h3>
        <p>
          Choose a gesture that feels right. Add a few words if you’d like. No
          pressure, always your choice.
        </p>
      </li>
      <li>
        <span>03</span>
        <h3>See the thought behind it.</h3>
        <p>
          <ModeText pick="howItWorksPay" />
        </p>
      </li>
    </ol>
  );
}
