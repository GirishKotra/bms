# bms — BookMyShow seat availability watcher

A small Node.js script that polls the BookMyShow seat layout for a single show, decrypts the response, and pushes a phone notification (via [ntfy](https://ntfy.sh)) the moment a seat you care about becomes available.

Requires Node.js >= 18 (uses the built-in `fetch`).

## Features

- **Seat layout polling**: calls the BookMyShow `GETSEATLAYOUT` endpoint for a venue + session every `--poll-interval-ms` (default 60s).
- **Response decryption**: the seat layout comes back AES-CBC encrypted. The script decrypts it with `crypto-js` and parses the row/seat encoding.
- **Wanted-seat filters**: alerts only for seats inside the row/seat ranges you configure with `--seats` or the config file's `seats` (see below). With no seats configured, **every available seat is alerted**.
- **Push alerts via ntfy**: sends one message per poll listing every newly available wanted seat (e.g. `Seats M15, M16 available!`) to `https://ntfy.sh/<topic>`, repeated `--alert-repeat` times (default 3), `--alert-repeat-interval-ms` apart (default 10s), so it's hard to miss.
- **No duplicate alerts**: each seat alerts once while it stays available. When it gets booked again, it is forgotten, so it alerts again if it reopens.
- **Status snapshot**: every poll writes `status.json` with the timestamp, total available seats, counts per row and per category, and the list of wanted seats currently available.
- **Layout viewer**: `--print-layout` fetches once and prints the category legend and an ASCII seat map (`[xx]` = available, `xx` = booked, `..` = no seat), grouped by category.
- **Failure alerts**: if the watcher is failing or has to stop, it tells you on the same ntfy topic (see [Error handling](#error-handling)).

## Setup

```sh
npm install
```

Install the [ntfy app](https://ntfy.sh) on your phone and subscribe to a hard-to-guess topic name. Anyone who knows the topic can read and post to it.

## Finding the venue code and session id

Open the show's seat-selection page on BookMyShow. The URL looks like:

```
https://in.bookmyshow.com/movies/<city>/seat-layout/<eventCode>/<venueCode>/<sessionId>/<date>
https://in.bookmyshow.com/movies/bengaluru/seat-layout/ET00451914/ACKB/16660/20261126
```

Here the venue code is `ACKB` and the session id is `16660`. Both are required.

## Usage

```sh
# Watch a show and alert on wanted seats
NTFY_TOPIC=my-secret-topic node bms.js --venue-code=ACKB --session-id=16660 --seats="B:12-30;J:10-22;C,D,E:12-25"

# Print the seat map once and exit
node bms.js --venue-code=ACKB --session-id=16660 --print-layout

# Everything from a config file
node bms.js --config=config.json
```

`node bms.js --help` prints all options.

### CLI flags

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

### Seats

`--seats` takes `ROWS:FROM-TO` entries (inclusive seat numbers) separated by `;`. Rows sharing a range are separated by `,`:

```sh
--seats="B:12-30;J:10-22;C,D,E,F,G,H,I,K,L,M:12-25"
```

A row listed in no entry is never alerted on. If no seats are configured at all, every available seat in the show is alerted. Row names are case-sensitive and must match the seat map exactly (check with `--print-layout`).

### Environment variables

| Env var | Purpose |
|---|---|
| `NTFY_TOPIC` | ntfy topic to send alerts to (same as `--ntfy-topic`) |
| `BMS_CLIENT_IP` | Value sent in the `true-client-ip` and `x-tp-client-id` headers |

### Config file

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

## Error handling

- **Transient errors** (network error, timeout after 15s, non-200 HTTP status, response that isn't JSON or lacks the expected keys, `blnSuccess: "false"`): logged, and polling continues. After 5 consecutive failures the script sends one ntfy message, `bms watcher failing: <last error>`. It sends no more until a poll succeeds and a new streak of 5 failures begins.
- **Fatal errors** (decryption fails or returns nothing, the decrypted data is not in the expected format): retrying won't help, so the script sends one ntfy message, `bms watcher stopped: <reason>`, and exits with code 1. This probably means BookMyShow changed its format.
- With `--print-layout`, any error is logged, nothing is sent to ntfy, and the exit code is 1.

## Notes

- Seats with status codes `1`, `4`, `7` or `8` count as available.
- `parseRow` and `parseSeatLayout` in `bms.js` document the decrypted data format.
- This is an unofficial personal tool built on BookMyShow's undocumented web API. It may break without warning. Use it responsibly and keep the poll interval reasonable.
