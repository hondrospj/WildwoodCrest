# Wildwood Crest history and forecast update

The September 2026 update separates three uses of the archive:

| View | Data and rule |
| --- | --- |
| Flooding throughout the year | Genuine USGS 01411390 records, starting May 29, 2000; no Lewes or crest-only records |
| Flooding over the years | Lewes NOAA 8557380 from February 1919 before the local record, then USGS; official date authority applied only to annual counting |
| Historic flooding filter | All stored measured bucket peaks and all official crests, deduplicated only by exact timestamp/level; local-date filters |

Lewes levels are unadjusted NAVD88 surrogate observations, not measurements at
Wildwood Crest. Missing annual coverage is null, not zero. Tooltips disclose
source and partial-year day coverage. Counts use the maximum in each local civil
AM/PM bucket, not every sampled water level. Official USGS Grassy Sound crests
are retained separately and unchanged in the historic catalogue.

When the seasonal forecast is on, only its forecast and uncertainty datasets
are plotted. Past-forecast selection is restricted to the preceding five
calendar years; the restriction also applies to manually entered years.
Those hindcasts use the local USGS training record, not unadjusted Lewes levels.

PETSS uses station 8535901, with the run timestamp displayed alongside the latest
USGS observation. Missing/sentinel values are rejected, expired runs are not
shown as current forecasts, and the updater requires at least 72 future hours.

Run `node tools/test_dashboard.cjs` for offline data and VM regression tests.
Run `node tools/update_history.js` for an incremental update. The optional
`--backfill` rebuilds the pre-local Lewes record and fills the early USGS record;
`--lewes-file=PATH` can use a verified local compact Lewes archive.

The data workflows validate their outputs and deploy updated Pages artifacts
directly, avoiding reliance on bot-generated commits triggering another workflow.
