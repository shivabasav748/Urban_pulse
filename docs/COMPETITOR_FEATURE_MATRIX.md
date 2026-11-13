# Competitor Feature Matrix

Method: REA headless Chromium captures (1440×900, en-IN, logged out) on 13 Nov 2026, plus a raw HTML fetch for Rapido. We did not bypass login or CAPTCHA and did not decompile bundles. Booking beyond address entry requires login (Uber) or location permission + reCAPTCHA (Ola), so matching and pricing internals are **unavailable**. Sujal can extend this with mobile captures.

| Product | Feature / pattern | Evidence URL | Status | Relevance | Priority |
|---|---|---|---|---|---|
| Uber | City chip + "Change city" above the booking form | https://www.uber.com/in/en/ | observed | Show "Belagavi (demo)" context | P2 |
| Uber | "Pickup now" time selector | https://www.uber.com/in/en/ | observed | Now-only; scheduling is a non-goal | skip |
| Uber | Pickup + Dropoff inputs joined by a vertical connector line | https://www.uber.com/in/en/ | observed | Connected place selectors | P0 |
| Uber | "Auto-fill my location" button in the pickup field | https://www.uber.com/in/en/ | observed | "Use my location" (simulated) | P1 |
| Uber | "See prices" CTA before login | https://www.uber.com/in/en/ | observed | Estimate first, then request | P0 |
| Uber | Products: Ride, Reserve, Uber Bike, Intercity, Parcel, Airport | https://www.uber.com/in/en/ | observed | Bike / Auto / Cab categories only | P0 |
| Uber | Steps: get started → matched with a nearby driver, notified when close → verify driver name/vehicle → ride → rate and tip | https://www.uber.com/in/en/ | observed | Tracker states, driver card with plate, post-trip rating | P0 / P2 rating |
| Uber | Separate driver entry ("Drive", drivers.uber.com) | https://www.uber.com/in/en/ | observed | Role choice at signup | P0 |
| Uber | Actual dispatch / pricing logic | m.uber.com (login) | unavailable | Our own documented algorithms | — |
| Ola | Desktop split: booking panel left, large visual right | https://book.olacabs.com/ | observed | Left panel + map (map replaces the photo) | P0 |
| Ola | Tabs: Daily Rides / Outstation / Rentals | https://book.olacabs.com/ | observed | Daily rides only | skip others |
| Ola | FROM / TO / WHEN fields | https://book.olacabs.com/ | observed | Same order | P0 |
| Ola | Location-permission explainer sheet with "Enter pickup manually" fallback | https://book.olacabs.com/ | observed | Permission explainer + manual fallback | P2 |
| Ola | reCAPTCHA on the booking page | https://book.olacabs.com/ | observed | Not needed for the demo | skip |
| Rapido | Bike Taxi vs Cabs/Auto split (separate terms pages) | https://www.rapido.bike/Home (footer HTML) | observed | Bike / Auto / Cab categories | P0 |
| Rapido | "Captain" naming for drivers; separate Captain app | https://www.rapido.bike/Home | observed | Use "Captain" in driver UI | P1 |
| Rapido | Safety page in nav | https://www.rapido.bike/Home | observed | Safety card (share trip, simulated) | P2 |
| Rapido | Booking hero / flow | https://www.rapido.bike/Home | unavailable (JS-rendered; 3 capture attempts failed) | — | — |
| All | Native apps | — | not inspected | — | — |
