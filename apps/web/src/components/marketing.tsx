/** Marketing pieces shared by the home page and the PRD marketing routes. */

/** Decorative illustration of something a creator shared. */
export function CreatorArt() {
  return (
    <div className="creator-art" aria-hidden="true">
      <div className="mini-browser">
        <div className="browser-chrome">
          <i />
          <i />
          <i />
          <span>something worth sharing</span>
        </div>
        <div className="browser-body">
          <span className="art-asterisk">✳</span>
          <strong>
            Made with care.
            <br />
            <em>Shared with you.</em>
          </strong>
          <div className="art-lines">
            <i />
            <i />
            <i />
          </div>
        </div>
      </div>
      <div className="art-tag">Ideas that stay with you. ↗</div>
    </div>
  );
}

/** The three-step explanation; truthful about this build stopping before payment. */
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
          Preview your appreciation. This build stops here—checkout and payments
          are not available.
        </p>
      </li>
    </ol>
  );
}
