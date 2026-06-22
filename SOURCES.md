## Sources

**NY Courts DIY / e-filing / NYSCEF**
- https://www.nycourts.gov/help/diy-forms
- https://www.nycourts.gov/landlord-and-tenant-forms
- https://www.nycourts.gov/courthelp/diy/nyccivil_housing.shtml
- https://www.law.cornell.edu/regulations/new-york/22-NYCRR-208.4a
- https://www.nycbar.org/wp-content/uploads/2026/01/E-filing-Memo-Expansion-NYC-Civil-Court-mandatoy-Landlord-Tenant.pdf
- https://iappscontent.courts.state.ny.us/NYSCEF/live/help/UnrepresentedFactSheet.pdf
- https://iappscontent.courts.state.ny.us/nyscef/live/legislation.htm
- https://support.lawhelpinteractive.org/hc/en-us/articles/221936468-About-Us

*Re-verify before reliance: whether mandatory NYC L&T e-filing took effect as a FINAL order (the "effective Feb 23 2026" vs "Zayas authorization Mar 2 2026" vs "Jan 2026 proposal w/ Feb 17 2026 comment deadline" dates are internally inconsistent); AND confirm that pro se litigants remain STATUTORILY EXEMPT from mandatory e-filing under the 2015 legislation (they may opt in but are never compelled) — this narrows the assisted-e-filing funnel materially.*

**JustFix / Who Owns What / NYCDB**
- https://www.justfix.org/en/
- https://www.justfix.org/en/tools/
- https://github.com/JustFixNYC/who-owns-what
- https://github.com/JustFixNYC/who-owns-what/blob/master/client/src/components/APIClient.ts  *(authoritative endpoint list: `/api/address`, `/api/address/wowza`, `/api/address/buildinginfo`, `/api/address/indicatorhistory` — the previously-cited `/api/address/aggregate` is NOT present and should be treated as stale/invented)*
- https://api.justfix.org/api/dataset/tracker  *(confirmed live + unauthenticated 2026-06-22; portfolio/building-info endpoints NOT independently confirmed live in this review — re-verify)*
- https://whoownswhat.justfix.org/en/how-it-works
- https://github.com/JustFixNYC/tenants2
- https://github.com/nycdb/nycdb

**Address resolver (corrected)**
- https://geosearch.planninglabs.nyc/  *(open GeoSearch — use this + PLUTO/PAD; the legacy NYC Geoclient API is DEPRECATED and not interchangeable)*

**Adjacent AI / SRL tools**
- https://www.lawnext.com/2025/01/ai-powered-tool-launches-to-help-new-york-tenants-enforce-their-repair-rights.html
- https://housingcourtanswers.org/roxanne/
- https://www.lawnext.com/2026/04/courtroom5-launches-the-law-accelerator-a-structured-program-to-help-self-represented-litigants-navigate-civil-court.html
- https://justiceinnovation.law.stanford.edu/projects/ai-access-to-justice/
- https://www.justicebench.org/
- https://www.gavel.io/document-types/eviction-notice
- https://laist.com/news/housing-homelessness/dennis-block-chatgpt-artificial-intelligence-ai-eviction-court-los-angeles-lawyer-sanction-housing-tenant-landlord

**NYC referral / RTC / HRA layers**
- https://www.nyc.gov/site/hra/help/legal-services-for-tenants.page
- https://www.righttocounselnyc.org/faq
- https://citylimits.org/fewer-eligible-tenants-get-right-to-counsel-after-pandemic-program-expansion-report/
- https://comptroller.nyc.gov/reports/evictions-up-representation-down/  *(supports ~71% FY21 → ~42% FY24 full-rep decline; the "~30% by early 2025" point and "Q4 FY" labels are OVER-PRECISE and not cleanly pinpointed here — re-source. The "demand tripled (~222%)/funding +129%" pairing is NOT this report's figure; primary framing is eligibility roughly doubling (~110%, 2022–2024) and RTC funding up ~33% — re-verify against the primary report/IBO.)*
- https://rentguidelinesboard.cityofnewyork.us/resources/additional-housing-resources/
- https://www.lasmny.org/services/tenant-defense-project/
- https://www.lawhelpny.org/
- https://www.lawhelpny.org/what-is-livehelp
- https://www.nyc.gov/assets/hra/downloads/pdf/services/civiljustice/OCJ_Annual_Report_2025.pdf
- https://www.nyc.gov/assets/hra/downloads/pdf/services/civiljustice/OCJ_Annual_Report_2024.pdf

*Provider-strain figures used in positioning ("attrition 20–55%/yr," "hours/case +24% since 2018," "caseloads 50–80 vs ~48 recommended") are currently UNCITED and must each be sourced or dropped — they are the quantitative backbone of the capacity-multiplier thesis.*

**NYC open data / housing datasets**
- https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Violations/wvxf-dwi5/data
- https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Complaints-and-Problems/ygpa-z7cr
- https://data.cityofnewyork.us/Housing-Development/Registration-Contacts/feu5-w2e2
- https://data.cityofnewyork.us/Housing-Development/DOB-Violations/3h2n-5cm9
- https://data.cityofnewyork.us/City-Government/ACRIS-Real-Property-Parties/636b-3b5g
- https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2020-to-Present/erm2-nwe9
- https://dev.socrata.com/docs/app-tokens.html
- https://hcr.ny.gov/records-access  *(DHCR rent history is MANUAL/mailed/portal, tenant-identity-gated, non-machine-readable scanned PDFs, no API — `scrape_or_manual` w/ human-in-loop, NOT clean `document_assembly`)*
- https://rentguidelinesboard.cityofnewyork.us/resources/rent-stabilized-building-lists/
- https://bbgllp.com/new/state-legislature-enacts-good-cause-eviction-amendments-to-iai-provisions-and-a-tax-benefit-program-to-replace-421-a/

**Court case data / reminders**
- https://iapps.courts.state.ny.us/webcivilLocal/LCMain
- https://iapps.courts.state.ny.us/webcivil/etrackLogin
- https://iapps.courts.state.ny.us/webcivil/etrackFAQ
- https://github.com/nycdb/nycdb/wiki/Dataset:-OCA-Housing-Court-Records
- https://github.com/housing-data-coalition/oca
- https://nysba.org/legalease-the-use-of-tenant-screening-reports-and-tenant-blacklisting/
- https://www.advancingpretrial.org/wp-content/uploads/2025/09/Court-Date-Notification-Systems_updated-April-2024.pdf
- https://www.ideas42.org/wp-content/uploads/2020/10/Behavioral-nudges-reduce-failure-to-appear-for-court_Science.full_.pdf  *(EXTERNAL-VALIDITY FLAG: this is CRIMINAL-summons FTA research; do NOT transfer its 12–53% / ~36% reduction magnitudes to Housing Court eviction appearances as an expected effect — measure in-context)*
- https://pmc.ncbi.nlm.nih.gov/articles/PMC12487872/
- https://www.prweb.com/releases/the-legal-aid-society-and-uptrust-launch-court-date-reminder-text-message-service-862633827.html
- https://furmancenter.org/research/publication/half-the-battle-is-just-showing-up  *(supports non-answer/default-judgment magnitude in nonpayment cases; the "~92% of defaults at first appearance" statistic is NOT evident here — drop or re-source; do not conflate non-answer with failure-to-appear)*

**Intake/CMS handoff + taxonomy + funding**
- https://www.legalserver.org/news/new-yorks-legal-aid-community-embraces-legalserver/
- https://help.legalserver.org/article/1686-apis-application-programming-interfaces
- https://help.legalserver.org/article/1880-online-intake-with-legalserver
- https://www.legalserver.org/integrations/
- https://betterinternet.law.stanford.edu/about-the-project/taxonomy-nsmiv2/
- https://www.lsc.gov/i-am-grantee/grantee-guidance/lsc-reporting-requirements/case-service-reporting/csr-handbook-2017
- https://www.probono.net/programs/lhi/
- https://docs.developers.clio.com/
- https://www.nyc.gov/site/mayorspeu/resources/right-to-counsel.page
- https://www.lsc.gov/press-release/lsc-awards-59-million-technology-grants-31-civil-legal-aid-providers
- https://www.nber.org/papers/w29836

*LSC-TIG funding constraint to reconcile: TIG flows ONLY to LSC grantees; in NYC the sole LSC grantee is Legal Services NYC (Legal Aid Society, NYLAG, Bronx Defenders, Mobilization for Justice, TakeRoot, CAMBA, etc. are NOT LSC-funded). LSC grantees are barred from serving undocumented immigrants (program-integrity rule, even with non-LSC funds) — a large share of the target population. Verify these constraints and resolve via non-LSC funding/partners for the undocumented-inclusive build.*

**Document-assembly engines**
- https://docassemble.org/
- https://docassemble.org/docs/license.html
- https://docassemble.org/docs/docker.html
- https://github.com/SuffolkLITLab/docassemble-AssemblyLine
- https://assemblyline.suffolklitlab.org/
- https://github.com/GBLS/docassemble-MAEvictionDefense  *(reuse SCAFFOLDING only — MA summary-process legal branching is not portable to NY; rebuild NY legal logic)*
- https://www.gavel.io/pricing
- https://www.a2jauthor.org/content/hosting-your-own-a2j-guided-interviews

**Rental assistance / benefits**
- https://access.nyc.gov/programs/one-shot-deal/  *(discretionary, repayment/recoupment conditions, often does not cover market arrears — NOT a clean ERAP substitute; NO submission API — tenant manual upload only)*
- https://otda.ny.gov/programs/emergency-rental-assistance/  *(ERAP CLOSED — do not build toward it)*
- https://www.thecityreporter.nyc/2026/03/24/cityfheps-mamdani-vouchers-court-appeal/  *(CityFHEPS expansion in active litigation at the Court of Appeals — eligibility may flip; sequence CityFHEPS-dependent logic AFTER appeal resolves)*
- https://access.nyc.gov/programs/family-homelessness-and-eviction-prevention-supplement-fheps/
- https://www.nyc.gov/site/rentfreeze/apply/apply-renew.page
- https://screeningapidocs.cityofnewyork.us/overview  *(eligibility SCREENING only — no application submission anywhere in ACCESS HRA stack)*
- https://github.com/NYCOpportunity/
- https://data.cityofnewyork.us/Social-Services/NYC-Benefits-Screening-API/qcqw-kzj6
- https://bplc.cssny.org/benefit_tools

**Legal / compliance (UPL, AI-chatbot liability, FCRA, privacy, SMS)**
- https://law.justia.com/codes/new-york/jud/article-15/478/
- https://law.justia.com/cases/federal/appellate-courts/ca2/22-1345/22-1345-2025-09-09.html  *(2d Cir. VACATED-AND-REMANDED under INTERMEDIATE scrutiny; did NOT settle that free individualized help is UPL; cert petition w/ Institute for Justice filed ~Feb 2026 — posture UNRESOLVED. Correct any text implying it "confirms ... is regulable UPL.")*
- NY S7263 / S7263A (Sen. Gonzalez) — imposes CIVIL LIABILITY on chatbot "PROPRIETOR" (owner/operator/deployer) for outputs amounting to legal advice; passed Senate Internet & Technology Committee early Mar 2026 — verify current status via the NY Senate bill page; TOP-TIER product-specific risk (private right of action against a tool like this), not a peripheral UPL note.
- https://www.nycourts.gov/access-justice-division/access-justice-court-navigator-program
- https://library.law.unc.edu/2025/02/aba-formal-opinion-512-the-paradigm-for-generative-ai-in-legal-practice/  *(governs LICENSED LAWYERS' GenAI use — cannot be claimed as cover unless a supervising attorney is genuinely in the loop and accountable)*
- https://www.ftc.gov/news-events/news/press-releases/2025/02/ftc-finalizes-order-donotpay-prohibits-deceptive-ai-lawyer-claims-imposes-monetary-relief-requires
- https://www.ncsc.org/sites/default/files/media/document/AI_UPL_WhitePaper.pdf
- 22 NYCRR 130 (frivolous-conduct sanctions) + Mata v. Avianca line — filer (the pro se tenant) bears sanction/credibility risk for any wrong auto-asserted fact from stale open data; verify current sanctions standard.
- https://opendata.cityofnewyork.us/open-data-law/
- https://www.law.cornell.edu/uscode/text/15/1681a
- https://www.ftc.gov/business-guidance/resources/what-tenant-background-screening-companies-need-know-about-fair-credit-reporting-act
- https://ag.ny.gov/resources/organizations/data-breach-reporting/shield-act
- https://www.uscis.gov/policy-manual/volume-1-part-a-chapter-7
- https://www.infobip.com/blog/tcpa-compliance-sms
- https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-for-government-and-non-profit-agencies
- https://www.hklaw.com/en/insights/publications/2026/03/tcpa-reset-fifth-circuit-rejects-prior-express-written-consent-rule

*Note: several nycourts.gov and nyc.gov pages, plus the OCJ Annual Report PDFs and the NYC Opportunity key-provisioning page, returned 403/Cloudflare challenges to automated fetching; findings were corroborated via primary PDFs and secondary sources. Before operational reliance, re-verify: (1) the FINAL e-filing administrative order and the pro-se exemption; (2) the corrected RTC/funding figures against the primary Comptroller/IBO report; (3) the Furman "92%" and the criminal-summons FTA external-validity issues; (4) the live WoW portfolio endpoints (not just `/dataset/tracker`); (5) S7263's current status; (6) the LSC-grantee-in-NYC and undocumented-population constraints; (7) live API terms and exact eligibility thresholds.*
