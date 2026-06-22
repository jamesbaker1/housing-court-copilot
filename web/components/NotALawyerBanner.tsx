/**
 * NotALawyerBanner — the persistent "guide, not a lawyer" framing.
 *
 * This is a TRUST FEATURE, not chrome. It is rendered app-wide (the Foundation
 * layout already renders an inline version; this component is the reusable,
 * styled banner module engineers can drop anywhere the framing must be visible).
 *
 * The product is NEVER marketed as an "AI lawyer." This copy is non-negotiable.
 */
import { PERSISTENT_BANNER, PERSISTENT_BANNER_SHORT } from "@/lib/disclaimers";

export interface NotALawyerBannerProps {
  /**
   * `short` shows the one-line chip (mobile / tight spaces); `full` shows the
   * complete framing sentence. Defaults to `short`.
   */
  variant?: "short" | "full";
  /** When true, the banner sticks to the top of its scroll container. */
  sticky?: boolean;
  className?: string;
}

export default function NotALawyerBanner({
  variant = "short",
  sticky = false,
  className = "",
}: NotALawyerBannerProps) {
  const text = variant === "short" ? PERSISTENT_BANNER_SHORT : PERSISTENT_BANNER;

  return (
    <div
      role="note"
      aria-label="Important: this is a guide, not a lawyer"
      className={[
        sticky ? "sticky top-0 z-40" : "",
        "w-full border-b border-trust-200 bg-trust-100/95 px-4 py-2",
        "text-sm text-trust-800 backdrop-blur",
        "flex items-start gap-1.5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span aria-hidden="true" className="mt-px font-semibold text-trust-900">
        ⚖️
      </span>
      <span className={variant === "full" ? "font-medium" : "font-medium"}>
        {text}
      </span>
    </div>
  );
}
