# UI Layout Refinement Design

## Scope

Refine the Mini Parking UI around the approved "map workbench" direction. The homepage is the main target; detail, vehicles, and add/edit pages should be made visually consistent where they currently feel redundant or uneven.

## Homepage

- Keep the location-first, map-first flow.
- Make the map the first-screen workspace.
- Keep only lightweight top actions over the map.
- Keep map controls floating near the visible map edge.
- Collapse the bottom sheet into a clear task summary, one compact config row, and a first recommendation preview.
- In expanded sheet state, show the editable controls and full recommendations without duplicating the same destination, duration, and vehicle controls in multiple places.

## Supporting Pages

- Detail page: lead with parking name, address, price, duration, vehicle context, and navigation. Move trust, pricing, entrance, evidence, and metadata into scannable sections.
- Vehicles page: lead with current vehicle and a single add action. Make vehicle cards easier to scan and keep edit/delete actions secondary.
- Add/edit page: keep the existing form behavior but present it as a step-like flow: photo recognition, basic information, map data, pricing, and real-world factors.

## Constraints

- Do not reintroduce offline business data caches.
- Do not change the CloudBase/Supabase API behavior.
- Preserve existing page methods where possible.
- Keep WeChat Mini Program WXML/WXSS compatible and avoid adding new UI dependencies.
