/**
 * Progress dots for the setup wizard.
 *
 * Lifted out of `app/setup/page.tsx` so individual step components can
 * stay focused on their own content while the page-level shell renders
 * the indicator above whichever step is active.
 *
 * Behavior is unchanged from the inline version: the active step is a
 * wider, full-opacity pill; passed steps are short and 40% opacity;
 * upcoming steps are short and use the separator token. Width + colour
 * transitions are tween'd over 300ms (matches the step `animate-in
 * fade-in duration-300` pacing).
 */
export function ProgressDots<TStep extends string>({
  steps,
  current,
}: {
  steps: readonly TStep[];
  current: TStep;
}) {
  const currentIndex = steps.indexOf(current);
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((s, i) => (
        <div
          key={s}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            s === current
              ? "w-8 bg-accent"
              : currentIndex > i
              ? "w-4 bg-accent/40"
              : "w-4 bg-separator"
          }`}
        />
      ))}
    </div>
  );
}
