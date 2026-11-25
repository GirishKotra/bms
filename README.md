# bms — BookMyShow watchers

Two small Node.js scripts that poll BookMyShow and push a phone notification (via [ntfy](https://ntfy.sh)) when something you are waiting for shows up:

| Script | Watches for |
|---|---|
| [`bms.js`](#bmsjs--seat-watcher) | wanted seats opening up in one show |
| [`formats.js`](#formatsjs--format-watcher) | a movie being listed in a given screen format (e.g. Dolby Cinema) at chosen theatres |

Both share `common.js` (option parsing, ntfy alerts, polling loop, error handling).

Requires Node.js >= 18 (uses the built-in `fetch`).

## Setup

```sh
npm install
```

Install the [ntfy app](https://ntfy.sh) on your phone and subscribe to a hard-to-guess topic name. Anyone who knows the topic can read and post to it.

## bms.js — seat watcher

Polls the BookMyShow seat layout for a single show, decrypts the response, and alerts the moment a seat you care about becomes available.

### Features

- **Seat layout polling**: calls the BookMyShow `GETSEATLAYOUT` endpoint for a venue + session every `--poll-interval-ms` (default 60s).
- **Response decryption**: the seat layout comes back AES-CBC encrypted. The script decrypts it with `crypto-js` and parses the row/seat encoding.
- **Wanted-seat filters**: alerts only for seats inside the row/seat ranges you configure with `--seats` or the config file's `seats` (see below). With no seats configured, **every available seat is alerted**.
- **Push alerts via ntfy**: sends one message per poll listing every newly available wanted seat (e.g. `Seats M15, M16 available!`) to `https://ntfy.sh/<topic>`, repeated `--alert-repeat` times (default 3), `--alert-repeat-interval-ms` apart (default 10s), so it's hard to miss.
- **No duplicate alerts**: each seat alerts once while it stays available. When it gets booked again, it is forgotten, so it alerts again if it reopens.
- **Status snapshot**: every poll writes `status.json` with the timestamp, total available seats, counts per row and per category, and the list of wanted seats currently available.
- **Layout viewer**: `--print-layout` fetches once and prints the category legend and an ASCII seat map (`[xx]` = available, `xx` = booked, `..` = no seat), grouped by category.
- **Failure alerts**: if the watcher is failing or has to stop, it tells you on the same ntfy topic (see [Error handling](#error-handling)).

### Finding the venue code and session id

Open the show's seat-selection page on BookMyShow. The URL looks like:

```
https://in.bookmyshow.com/movies/<city>/seat-layout/<eventCode>/<venueCode>/<sessionId>/<date>
https://in.bookmyshow.com/movies/bengaluru/seat-layout/ET00451914/ACKB/16660/20261126
```

Here the venue code is `ACKB` and the session id is `16660`. Both are required.

### Usage

```sh
# Watch a show and alert on wanted seats
NTFY_TOPIC=my-secret-topic node bms.js --venue-code=ACKB --session-id=16660 --seats="B:12-30;J:10-22;C,D,E:12-25"

# Print the seat map once and exit
node bms.js --venue-code=ACKB --session-id=16660 --print-layout

# Everything from a config file
node bms.js --config=config.json
```

`node bms.js --help` prints all options.

#### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--venue-code=<code>` | required | BookMyShow venue code |
| `--session-id=<id>` | required | BookMyShow session id |
| `--seats=<spec>` | none (all seats) | Seats to alert on, see below |
| `--print-layout` | off | Print seat map once and exit |
| `--poll-interval-ms=<ms>` | `60000` | Time between polls (>= 1) |
| `--ntfy-topic=<topic>` | `$NTFY_TOPIC` | ntfy topic; required unless `--print-layout` |
| `--alert-repeat=<n>` | `3` | Times each alert is sent (>= 1) |
| `--alert-repeat-interval-ms=<ms>` | `10000` | Gap between repeated alerts (>= 0) |
| `--config=<path>` | none | JSON config file |
| `-h`, `--help` | | Show usage and exit |

Unknown flags are rejected.

#### Seats

`--seats` takes `ROWS:FROM-TO` entries (inclusive seat numbers) separated by `;`. Rows sharing a range are separated by `,`:

```sh
--seats="B:12-30;J:10-22;C,D,E,F,G,H,I,K,L,M:12-25"
```

A row listed in no entry is never alerted on. If no seats are configured at all, every available seat in the show is alerted. Row names are case-sensitive and must match the seat map exactly (check with `--print-layout`).

#### Environment variables

| Env var | Purpose |
|---|---|
| `NTFY_TOPIC` | ntfy topic to send alerts to (same as `--ntfy-topic`) |
| `BMS_CLIENT_IP` | Value sent in the `true-client-ip` and `x-tp-client-id` headers |

#### Config file

`--config=<path>` loads a JSON object. All keys are optional; unknown keys are an error. See `config.example.json`:

| Key | Same as |
|---|---|
| `venueCode` | `--venue-code` |
| `sessionId` | `--session-id` |
| `ntfyTopic` | `--ntfy-topic` |
| `pollIntervalMs` | `--poll-interval-ms` |
| `alertRepeat` | `--alert-repeat` |
| `alertRepeatIntervalMs` | `--alert-repeat-interval-ms` |
| `seats` | `--seats`, as a map of row to `[from, to]`, one key per row |

```json
{
  "venueCode": "ACKB",
  "sessionId": "16660",
  "seats": { "B": [12, 30], "J": [10, 22], "C": [12, 25] }
}
```

`config.example.json` has no `ntfyTopic` on purpose: put your own in a local `config.json` (git-ignored) or use `NTFY_TOPIC`, so the secret topic is never committed.

Precedence, lowest to highest: built-in defaults, config file, env vars (`NTFY_TOPIC`), CLI flags. `--seats` replaces the config file's `seats` entirely rather than merging. `venueCode`, `sessionId` and `ntfyTopic` must be JSON strings (e.g. `"16660"`, not `16660`).

### Error handling

- **Transient errors** (network error, timeout after 15s, non-200 HTTP status, response that isn't JSON or lacks the expected keys, `blnSuccess: "false"`): logged, and polling continues. After 5 consecutive failures the script sends one ntfy message, `bms watcher failing: <last error>`. It sends no more until a poll succeeds and a new streak of 5 failures begins.
- **Fatal errors** (decryption fails or returns nothing, the decrypted data is not in the expected format): retrying won't help, so the script sends one ntfy message, `bms watcher stopped: <reason>`, and exits with code 1. This probably means BookMyShow changed its format.
- With `--print-layout`, any error is logged, nothing is sent to ntfy, and the exit code is 1.

## formats.js — format watcher

Alerts when chosen theatres start listing a chosen movie in a chosen screen format, e.g. Avengers: Doomsday in "DOLBY CINEMA" at ALLU Cinemas Kokapet, which today only shows it in "LASER 4K ATMOS". It then tells you the shows and their session ids.

### Finding the venue code

Open the theatre's page on BookMyShow. The venue code is the part before the date in the `buytickets` URL:

```
https://in.bookmyshow.com/cinemas/<city>/<slug>/buytickets/<VENUECODE>/<date>
https://in.bookmyshow.com/cinemas/hyderabad/allu-cinemas-kokapet/buytickets/ALUC/20261218
```

### Usage

```sh
NTFY_TOPIC=my-secret-topic node formats.js --venue-codes=ALUC --movie="Avengers: Doomsday" \
    --format="DOLBY CINEMA" --dates=20261218,20261219

node formats.js --config=formats.json
```

`node formats.js --help` prints all options.

| Flag | Default | Description |
|---|---|---|
| `--venue-codes=<codes>` | required | Comma-separated venue codes |
| `--movie=<title>` | required | Movie title to look for |
| `--format=<format>` | required | Screen format to look for |
| `--dates=<dates>` | required | Comma-separated show dates, `YYYYMMDD`; must be real calendar dates (`20260231` is rejected at startup) |
| `--poll-interval-ms=<ms>` | `300000` | Time between polls (>= 1) |
| `--ntfy-topic=<topic>` | `$NTFY_TOPIC` | ntfy topic; required |
| `--alert-repeat=<n>` | `3` | Times the alert is sent (>= 1) |
| `--alert-repeat-interval-ms=<ms>` | `10000` | Gap between repeated alerts (>= 0) |
| `--config=<path>` | none | JSON config file |
| `-h`, `--help` | | Show usage and exit |

Unknown flags are rejected. The config file takes the same settings as camelCase keys (`venueCodes` and `dates` as arrays of strings, `dates` as `"YYYYMMDD"`; items are trimmed and must not be empty); see `formats.example.json`. Unknown keys are an error. Precedence is the same as for `bms.js`: built-in defaults, config file, env vars (`NTFY_TOPIC`), CLI flags. Copy the example to `formats.json` (git-ignored) and add your `ntfyTopic` there, or use `NTFY_TOPIC`.

### How matching works

- **Movie**: the show's title (`EventTitle`) contains `--movie`, ignoring case. Not the event code: a Dolby edition of a movie may have a different one.
- **Format**: the show's screen attribute (`Attributes`, e.g. `LASER 4K ATMOS`, `DOLBY CINEMA`) contains `--format`, ignoring case. Runs of whitespace count as one space, so `dolby cinema` matches `DOLBY  CINEMA`. The edition label in the movie's name (e.g. `DOLBY CINEMA 3D` in the event dimension) is deliberately not used.
- **Dates**: only the dates you list are checked. A date BookMyShow has not opened for booking is treated as having no shows (BookMyShow answers such requests with the nearest open date, which is ignored).
- **Alert once, then exit**: as soon as any match exists for any venue and date, including shows already listed when the script starts, it sends one message listing all matches grouped by venue and date, repeated `--alert-repeat` times, then exits with code 0 once at least one send succeeded. If every send fails, the failure is logged, polling continues and the alert is retried on the next poll. Each show is listed with its time, screen and session id, plus its title and screen format when they differ from what you asked for (e.g. a longer title, or `LASER 4K ATMOS` when you asked for `LASER`). Long lists are cut with "...and N more".
- A venue code that returns no data at all (unknown code, or nothing open for booking) logs a one-time warning and keeps polling.

To pick a show after the alert, take its session id and run the seat watcher:

```sh
node bms.js --venue-code=<venue> --session-id=<id> --print-layout
```

The data comes from BookMyShow's `showtimes/byvenue` endpoint, which is cached for 5 minutes, so the default poll interval is 5 minutes and polling faster gains nothing. Every venue and date pair is requested on each poll, one after the other.

### Error handling

Same scheme as `bms.js`, with `bms format watcher` in the ntfy messages:

- **Transient errors** (network error, timeout after 15s, non-200 HTTP status, response that isn't JSON): logged, and polling continues. After 5 consecutive failed polls one message, `bms format watcher failing: <last error>`, is sent. A poll where one request failed still alerts if the other requests found a match. A failed alert delivery (every send failed) counts as a transient failure too.
- **Fatal errors** (the top-level structure is wrong: the body is not an object, `ShowDetails` is not an array, or `ShowDetails[0]` lacks `Date` / `Event`; this means BookMyShow changed its API): one message, `bms format watcher stopped: <reason>`, and exit code 1. If other venue/date pairs matched in the same poll, their alert is sent first.
- **Malformed entries** (an event without a title or `ChildEvents`, a `ChildEvent` without `ShowTimes`, a show without `Attributes`, or a matching show without `ShowDateTime`): skipped, with one warning per poll that gives the count. Not fatal.

## Notes

- In `bms.js`, seats with status codes `1`, `4`, `7` or `8` count as available.
- `parseRow` and `parseSeatLayout` in `bms.js` document the decrypted data format.
- These are unofficial personal tools built on BookMyShow's undocumented web APIs. They may break without warning. Use it responsibly and keep the poll interval reasonable.
