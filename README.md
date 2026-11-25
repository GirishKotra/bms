# bms — BookMyShow seat availability watcher

A small Node.js script that polls the BookMyShow seat layout for a single show, decrypts the response, and pushes a phone notification (via [ntfy](https://ntfy.sh)) the moment a seat you care about becomes available.

## Features

- **Seat layout polling**: calls the BookMyShow `GETSEATLAYOUT` endpoint for a venue + show every `--poll-interval` ms (default 60s).
- **Response decryption**: the seat layout comes back AES-CBC encrypted. The script decrypts it with `crypto-js` and parses the row/seat encoding.
- **Wanted-seat filters**: alerts only for seats inside configured per-row ranges:
  - Row `B`: seats 12–30
  - Row `J`: seats 10–22
  - Rows `C D E F G H I K L M`: seats 12–25

  To change these, edit `CUSTOM_ROW_RANGES`, `DEFAULT_RANGE_ROWS` and `DEFAULT_RANGE` in `bms.js`.
- **Push alerts via ntfy**: sends one message per poll listing every newly available wanted seat (e.g. `Seats M15, M16 available!`) to `https://ntfy.sh/<topic>`, repeated `--notify-repeat` times (default 3), `--notify-repeat-interval` ms apart (default 10s), so it's hard to miss.
- **No duplicate alerts**: each seat alerts once while it stays available. When it gets booked again, it is forgotten, so it alerts again if it reopens.
- **Status snapshot**: every poll writes `status.json` with the timestamp, total available seats, counts per row and per category, and the list of wanted seats currently available.
- **Layout viewer**: `--print-layout` fetches once and prints the category legend and an ASCII seat map (`[xx]` = available, `xx` = booked, `..` = no seat), grouped by category.

## Setup

```sh
npm install
```

Install the [ntfy app](https://ntfy.sh) on your phone and subscribe to a hard-to-guess topic name. Anyone who knows the topic can read and post to it.

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `NTFY_TOPIC` | yes (unless `--ntfy-topic` or `--print-layout`) | ntfy topic to send alerts to |
| `BMS_CLIENT_IP` | no | Value sent in the `true-client-ip` and `x-tp-client-id` headers |

## Usage

```sh
# Watch a show and alert on wanted seats
NTFY_TOPIC=my-secret-topic node bms.js --venue-code=ALUC --param1=2903

# Print the seat map once and exit
node bms.js --venue-code=ALUC --param1=2903 --print-layout
```

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--venue-code=<code>` | `ALUC` | BookMyShow venue code |
| `--param1=<id>` | `2903` | Show/session ID (`strParam1`) |
| `--print-layout` | off | Print seat map once and exit |
| `--poll-interval=<ms>` | `60000` | Time between polls |
| `--ntfy-topic=<topic>` | `$NTFY_TOPIC` | Overrides the env var |
| `--notify-repeat=<n>` | `3` | Notifications sent per alert |
| `--notify-repeat-interval=<ms>` | `10000` | Gap between repeated notifications |

The venue code and show ID are in the BookMyShow seat-selection URL or in the browser network requests to `doTrans.aspx`.

## Notes

- Seats with status codes `1`, `4`, `7` or `8` count as available.
- If BookMyShow returns an error (e.g. show ended, rate-limited), the script logs it and tries again on the next poll.
- This is an unofficial personal tool built on BookMyShow's undocumented web API. It may break without warning. Use it responsibly and keep the poll interval reasonable.
