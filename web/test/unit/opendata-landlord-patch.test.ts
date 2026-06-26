/**
 * composeLandlordPatch — open-data verify-gate + provenance integrity.
 *
 * Guards two fixes on the parties.landlord patch built by the open-data
 * orchestrator (SAFETY INVARIANT 3 — open-data values must never escape the
 * verify_before_file gate, and a value's gate must describe the value's source):
 *
 *  (1) When only WoW succeeds (registration missing/failed), the WoW-derived
 *      owner name must still carry an open_data assertion — never null — so
 *      computeOpenDataBlock can gate it.
 *  (2) The attached open_data assertion's provenance (dataset) must match the
 *      source of the registered_owner_name actually written, so a reviewer
 *      traces the value to the right dataset and staleness caveat.
 */
import { describe, it, expect } from "vitest";

import { composeLandlordPatch } from "@/lib/opendata/index";
import { buildOpenDataAssertion } from "@/lib/evidence";

const registrationAssertion = buildOpenDataAssertion({
  dataset: "hpd_registration_tesw-yqqr",
  datasetVersion: "2026-06-24T00:00:00Z",
  retrievedAt: "2026-06-24T00:00:00Z",
  endpoint: "https://data.cityofnewyork.us/registration",
});

const wowAssertion = buildOpenDataAssertion({
  dataset: "justfix_wow",
  datasetVersion: "2026-06-20T00:00:00Z",
  retrievedAt: "2026-06-24T00:00:00Z",
  endpoint: "https://wow.justfix.org/api",
});

describe("composeLandlordPatch", () => {
  it("WoW-only: WoW-derived owner name carries the WoW gate, never null (INVARIANT 3)", () => {
    const patch = composeLandlordPatch({
      registrationOwnerName: null,
      registrationAssertion: null, // registration failed → no assertion
      wowOwnerName: "Acme Holdings LLC",
      wowAssertion,
      wowLandlordId: "wow-123",
      registrationOnFile: null,
    });

    expect(patch.registered_owner_name).toBe("Acme Holdings LLC");
    // An open-data value was written → it MUST be gated.
    expect(patch.open_data).not.toBeNull();
    // And the gate must be the WoW one (provenance matches the value).
    expect(patch.open_data?.dataset).toBe("justfix_wow");
    expect(patch.open_data?.verify_before_file.state).toBe("unverified");
    expect(patch.wow_landlord_id).toBe("wow-123");
  });

  it("registration owner name → registration gate (provenance matches)", () => {
    const patch = composeLandlordPatch({
      registrationOwnerName: "Registered Owner Inc",
      registrationAssertion,
      wowOwnerName: "Acme Holdings LLC",
      wowAssertion,
      wowLandlordId: "wow-123",
      registrationOnFile: true,
    });

    expect(patch.registered_owner_name).toBe("Registered Owner Inc");
    expect(patch.open_data?.dataset).toBe("hpd_registration_tesw-yqqr");
  });

  it("registration ok but no owner name; WoW supplies the name → WoW gate (provenance fix)", () => {
    // Registration on file but with no usable owner contact; the name comes from
    // WoW. The attached gate must describe WoW, not the HPD registration dataset.
    const patch = composeLandlordPatch({
      registrationOwnerName: null,
      registrationAssertion, // registration succeeded (has a gate) ...
      wowOwnerName: "Acme Holdings LLC", // ... but the NAME is WoW-sourced
      wowAssertion,
      wowLandlordId: "wow-123",
      registrationOnFile: true,
    });

    expect(patch.registered_owner_name).toBe("Acme Holdings LLC");
    // Provenance must follow the value: WoW, not hpd_registration.
    expect(patch.open_data?.dataset).toBe("justfix_wow");
  });

  it("registration ok, no owner name anywhere → registration gate still attached", () => {
    const patch = composeLandlordPatch({
      registrationOwnerName: null,
      registrationAssertion,
      wowOwnerName: null,
      wowAssertion: null,
      wowLandlordId: null,
      registrationOnFile: false,
    });

    expect(patch.registered_owner_name).toBeNull();
    // No owner name written, but registration_on_file is still an open-data
    // signal → keep the registration gate so the party is never ungated.
    expect(patch.open_data?.dataset).toBe("hpd_registration_tesw-yqqr");
    expect(patch.registration_on_file).toBe(false);
  });
});
