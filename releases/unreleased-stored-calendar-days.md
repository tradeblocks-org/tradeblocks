# Unreleased — stored browser blocks keep their calendar days

**Browser storage migration (IndexedDB version 6 → 7).** The web app now stores trade, daily-log and reporting-log dates, a block's date range and the dated rows in its cached calculations as `YYYY-MM-DD` calendar days, not as moments in time tied to the timezone they were imported in. A block imported in one timezone and opened in another (after travel or on a new computer) now shows every trade, daily-log and reporting row on its original day in the Trading Calendar, the performance charts, the trade log, filters and exports.

The first time the updated app opens, it upgrades every existing block once. It works from each stored date alone: dates imported in a timezone less than 10 hours behind UTC or less than 12 hours ahead of it, and dates written by older versions at UTC midnight, are converted to their exact original day. Two kinds of date cannot be confirmed from what is stored:

- dates imported 10 to 12 hours behind UTC (as in Hawaii and American Samoa) or 12 to 14 hours ahead of it (as in New Zealand, Fiji, Tonga and Kiritimati), because one stored moment names a different day on each side of the date line;
- dates stored with a time of day rather than as a whole day.

Those dates keep the day the browser showed before the update, so nothing moves without notice. The block list and every analysis page for that block show a prompt naming the file(s) involved and how many dates could not be confirmed; they may be off by one day. Importing that file again (Edit block → replace the file) fixes the dates and clears the prompt for it. New imports are never flagged.

What users may see after the update: legacy rows that older versions stored at UTC midnight used to display a day early in browsers west of UTC (for example the Americas); they now show their true day. Cached charts and statistics are rebuilt from the upgraded data on first use. If the upgrade fails it leaves the stored data untouched and is retried on the next load. The MCP server, CSV imports and the library's in-memory `Date` fields are unchanged. This note does not bump a version or publish a release.
