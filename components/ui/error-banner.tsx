import { cx } from "./cx";

// Inline error banner on paper surfaces — red-tinted field shape.
export function ErrorBanner({ message, className }: { message: string; className?: string }) {
  return (
    <p
      role="alert"
      className={cx(
        "rounded-daylight-field border border-daylight-red/50 bg-daylight-red/10 px-4 py-3 text-sm text-daylight-red-deep",
        className,
      )}
    >
      {message}
    </p>
  );
}
