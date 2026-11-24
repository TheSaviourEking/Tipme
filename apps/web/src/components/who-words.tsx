/** One "Who it's for" row's words: the title (with a quiet "Coming soon" pill beside it), then the text. */
export function WhoWords({
  title,
  text,
  comingSoon,
}: {
  title: string;
  text: string;
  comingSoon?: boolean;
}) {
  return (
    <>
      <div className="who__head">
        <strong>{title}</strong>
        {comingSoon && <span className="who__soon">Coming soon</span>}
      </div>
      <span>{text}</span>
    </>
  );
}
