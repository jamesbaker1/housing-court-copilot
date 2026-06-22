/**
 * ResourceList — renders the static NYC free-help directory (`@/lib/resources`)
 * as a tap-to-call / tap-to-open list.
 *
 * This is the "route to existing help" surface. It is intentionally calm and
 * supportive: when someone lands here it's often because they asked an
 * advice-seeking question that we hard-route to a human (see disclaimers /
 * TALK_TO_A_PERSON_CTA). The primary resource (311 / Right to Counsel) is
 * highlighted as the place to start.
 *
 * No LLM output is shown here, so no per-item disclaimer is needed — but we
 * keep the supportive "free help is real and available" framing.
 *
 * Pure presentational client component. Pass a `borough` to surface the nearest
 * Housing Court Help Center first.
 */
"use client";

import {
  resourcesForBorough,
  telHref,
  type HelpResource,
  type ResourceCategory,
} from "@/lib/resources";
import { TALK_TO_A_PERSON_CTA } from "@/lib/disclaimers";
import type { Borough } from "@/lib/case";

const CATEGORY_LABEL: Record<ResourceCategory, string> = {
  hotline: "Phone help",
  right_to_counsel: "Right to Counsel",
  legal_aid: "Free legal aid",
  court_help_center: "Court Help Center",
};

export interface ResourceListProps {
  /** When provided, filters/sorts to citywide + this borough's Help Center. */
  borough?: Borough | null;
  /** Show the "Talk to a person" lead-in. Defaults true. */
  showHeading?: boolean;
  className?: string;
}

function ResourceCard({ resource }: { resource: HelpResource }) {
  const tel = telHref(resource.phone);
  return (
    <li
      className={
        "rounded-lg border p-4 " +
        (resource.isPrimary
          ? "border-trust-300 bg-trust-50"
          : "border-gray-200 bg-white")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            {CATEGORY_LABEL[resource.category]}
          </span>
          <h3 className="mt-1 text-base font-semibold text-gray-900">
            {resource.name}
          </h3>
          <p className="mt-1 text-sm text-gray-600">{resource.description}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {tel && resource.phone && (
          <a
            href={tel}
            className="inline-flex items-center gap-1 rounded-md bg-trust-600 px-3 py-2 text-sm font-medium text-white hover:bg-trust-700"
            aria-label={`Call ${resource.name} at ${resource.phone}`}
          >
            Call {resource.phone}
          </a>
        )}
        {resource.url && (
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Open website
          </a>
        )}
      </div>
    </li>
  );
}

export default function ResourceList({
  borough,
  showHeading = true,
  className,
}: ResourceListProps) {
  const resources = resourcesForBorough(borough);

  return (
    <section className={className} aria-label="Free legal help resources">
      {showHeading && (
        <header className="mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {TALK_TO_A_PERSON_CTA.heading}
          </h2>
          <p className="mt-1 text-sm text-gray-600">{TALK_TO_A_PERSON_CTA.body}</p>
        </header>
      )}

      <ul className="space-y-3">
        {resources.map((resource) => (
          <ResourceCard key={resource.id} resource={resource} />
        ))}
      </ul>

      <p className="mt-4 text-xs text-gray-500">
        {TALK_TO_A_PERSON_CTA.hotlineNote} This is a guide, not a lawyer — these
        are real, free places to get human help.
      </p>
    </section>
  );
}
