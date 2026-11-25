var CryptoJS = require('crypto-js');
var fs = require('fs');
var path = require('path');
var common = require('./common');

var fail = common.fail;
var fatalError = common.fatalError;

var STATUS_FILE_PATH = path.join(__dirname, 'status.json');

var AES_KEY = CryptoJS.enc.Utf8.parse('kYp3s6v9y$B&E)H+MbQeThWmZq4t7w!z');
var AES_IV = CryptoJS.lib.WordArray.create(0, 128);

// Seat status codes that mean a seat is available to book.
var AVAILABLE_STATUS_CODES = ['1', '4', '7', '8'];

var BMS_URL = 'https://services-in.bookmyshow.com/doTrans.aspx';

// Command-line options / config keys that hold a single value.
var OPTIONS = [
    { key: 'venueCode', flag: 'venue-code', type: 'string' },
    { key: 'sessionId', flag: 'session-id', type: 'string' },
    { key: 'ntfyTopic', flag: 'ntfy-topic', type: 'string' },
    { key: 'pollIntervalMs', flag: 'poll-interval-ms', type: 'int', min: 1 },
    { key: 'alertRepeat', flag: 'alert-repeat', type: 'int', min: 1 },
    { key: 'alertRepeatIntervalMs', flag: 'alert-repeat-interval-ms', type: 'int', min: 0 }
];

var HELP = [
    'bms - watch a BookMyShow show and send ntfy alerts when wanted seats open up.',
    '',
    'Usage: node bms.js --venue-code=<code> --session-id=<id> [options]',
    '',
    'Options:',
    '  --venue-code=<code>              BookMyShow venue code (required, e.g. ACKB)',
    '  --session-id=<id>                BookMyShow session id (required, e.g. 16660)',
    '  --seats=<spec>                   Seats to alert on: "ROWS:FROM-TO" entries separated by ";",',
    '                                   rows within an entry separated by ",".',
    '                                   e.g. "B:12-30;J:10-22;C,D,E:12-25"',
    '                                   Default: none set, so every available seat is alerted',
    '  --print-layout                   Print the seat map once and exit (no ntfy)',
    '  --poll-interval-ms=<ms>          Time between polls, >= 1 (default 60000)',
    '  --ntfy-topic=<topic>             ntfy topic to alert (required unless --print-layout)',
    '  --alert-repeat=<n>               Times each alert is sent, >= 1 (default 3)',
    '  --alert-repeat-interval-ms=<ms>  Gap between repeated alerts, >= 0 (default 10000)',
    '  --config=<path>                  JSON config file (see below)',
    '  -h, --help                       Show this help',
    '',
    'Environment variables:',
    '  NTFY_TOPIC                       ntfy topic (same as --ntfy-topic)',
    '  BMS_CLIENT_IP                    Sent as the true-client-ip / x-tp-client-id headers',
    '',
    'Config file keys (JSON object, all optional, unknown keys are rejected):',
    '  venueCode, sessionId, ntfyTopic, pollIntervalMs, alertRepeat, alertRepeatIntervalMs,',
    '  seats (object mapping row to [from, to], e.g. {"B": [12, 30], "C": [12, 25]})',
    '',
    'Precedence (later wins): built-in defaults < config file < env vars < command-line flags.',
    '',
    'Examples:',
    '  NTFY_TOPIC=my-secret-topic node bms.js --venue-code=ACKB --session-id=16660 --seats="B:12-30;C,D:12-25"',
    '  node bms.js --venue-code=ACKB --session-id=16660 --print-layout',
    '  node bms.js --config=config.json'
].join('\n');

function addSeatRange(seats, row, from, to, label) {
    if (row === '') {
        fail(label + ': empty row name');
    }
    if (seats[row]) {
        fail(label + ': row "' + row + '" is listed more than once');
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to) {
        fail(label + ': row "' + row + '" needs a seat range with 0 <= from <= to, got ' + JSON.stringify([from, to]));
    }
    seats[row] = [from, to];
}

// "B:12-30;C,D:12-25" -> { B: [12, 30], C: [12, 25], D: [12, 25] }
function parseSeatsFlag(text) {
    var seats = Object.create(null);
    text.split(';').forEach(function (entry) {
        var match = entry.match(/^([^:]+):(\d+)-(\d+)$/);
        if (!match) {
            fail('--seats: bad entry "' + entry + '", expected ROWS:FROM-TO, e.g. "B:12-30;C,D:12-25"');
        }
        match[1].split(',').forEach(function (row) {
            addSeatRange(seats, row.trim(), Number(match[2]), Number(match[3]), '--seats');
        });
    });
    return seats;
}

function parseSeatsConfig(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail('config "seats" must be an object mapping row to [from, to]');
    }
    var seats = Object.create(null);
    Object.keys(value).forEach(function (row) {
        var range = value[row];
        if (!Array.isArray(range) || range.length !== 2) {
            fail('config "seats": row "' + row + '" must be [from, to], got ' + JSON.stringify(range));
        }
        addSeatRange(seats, row, range[0], range[1], 'config "seats"');
    });
    return seats;
}

function loadSettings(argv) {
    var settings = common.loadSettings(argv, {
        help: HELP,
        options: OPTIONS,
        defaults: {
            pollIntervalMs: 60000,
            alertRepeat: 3,
            alertRepeatIntervalMs: 10000,
            seats: Object.create(null)
        },
        switches: ['print-layout'],
        extraFlags: ['seats'],
        extraConfigKeys: ['seats'],
        applyConfig: function (config, settings) {
            if (config.seats !== undefined) {
                settings.seats = parseSeatsConfig(config.seats);
            }
        },
        applyCli: function (cli, settings) {
            settings.printLayout = !!cli.switches['print-layout'];
            if (cli.flags.seats !== undefined) {
                settings.seats = parseSeatsFlag(cli.flags.seats);
            }
        }
    });

    if (!settings.venueCode || !settings.sessionId) {
        fail('--venue-code and --session-id are required (as flags or in the config file), see --help');
    }
    if (!settings.ntfyTopic && !settings.printLayout) {
        fail('Set NTFY_TOPIC env var, pass --ntfy-topic=<topic>, or set ntfyTopic in the config file (see --help)');
    }
    return settings;
}

var args = loadSettings(process.argv.slice(2));

var CLIENT_IP = process.env.BMS_CLIENT_IP;

// Seat keys ("<rowname><seatNumber>") already alerted on; cleared once a seat
// goes unavailable so it can re-trigger next time it opens up.
var alertedSeatKeys = new Set();

var headers = {
    'authority': 'services-in.bookmyshow.com',
    'accept': '*/*',
    'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7,es;q=0.6',
    'cache-control': 'no-store',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': 'https://in.bookmyshow.com',
    'referer': 'https://in.bookmyshow.com/',
    'sec-ch-ua': '"Google Chrome";v="117", "Not;A=Brand";v="8", "Chromium";v="117"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
    'x-app-code': 'WEB'
};
if (CLIENT_IP) {
    headers['true-client-ip'] = CLIENT_IP;
    headers['x-tp-client-id'] = CLIENT_IP;
}

var dataString = 'strCommand=GETSEATLAYOUT&strAppCode=WEB&strVenueCode=' + args.venueCode
    + '&lngTransactionIdentifier=0&strParam1=' + args.sessionId
    + '&strParam2=WEB&strParam3=&strParam4=&strParam5=Y&strParam6=&strParam7=&strParam8=&strParam9=&strParam10=&strFormat=json';

function decrypt(base64CipherText) {
    var decrypted;
    try {
        var ciphertext = CryptoJS.enc.Base64.parse(base64CipherText);
        decrypted = CryptoJS.AES.decrypt({
            ciphertext: ciphertext
        }, AES_KEY, {
            mode: CryptoJS.mode.CBC,
            iv: AES_IV
        }).toString(CryptoJS.enc.Utf8);
    } catch (err) {
        throw fatalError('decrypt failed: ' + err.message);
    }
    if (decrypted === '') {
        throw fatalError('decrypt returned empty data');
    }
    return decrypted;
}

function isSeatWanted(rowname, seatNumber) {
    var range = args.seats[rowname];
    if (Object.keys(args.seats).length === 0) {
        return true;
    }
    return range !== undefined && seatNumber >= range[0] && seatNumber <= range[1];
}

// One notification per poll for all newly available seats, so a big batch of
// seats opening at once doesn't hit ntfy's rate limit.
function alertSeatsAvailable(seatKeys) {
    var message = (seatKeys.length === 1 ? 'Seat ' : 'Seats ') + seatKeys.join(', ') + ' available!';
    common.alertBurst(args, message);
}

/*
 * One row block of the decrypted seat layout: "<rowcode>:<rowname>:<seat>:<seat>:...".
 *
 *   1:R:A101+01:A102+02:A103+03:A000+00:A206+05
 *
 *   rowcode  "1"   row identifier; purpose unknown (several rows can share one value)
 *   rowname  "R"   row label shown in the BookMyShow UI
 *   seat     "A206+05", i.e. <categoryLetter><statusCode><slotIndex>+<seatNumber>:
 *     categoryLetter  "A"   seating category, matches a letter in the legend (see
 *                           parseSeatLayout); rows are grouped by it, so the row's
 *                           categoryLetter is that of its first seat
 *     statusCode      "2"   availability; AVAILABLE_STATUS_CODES (1, 4, 7, 8) are
 *                           bookable, other values are taken/blocked/etc.
 *     slotIndex       "06"  physical column position in the row, including aisle gaps
 *     seatNumber      "05"  seat number shown in the UI; "00" (with status 0) is a gap
 *
 * Returns { rowcode, rowname, categoryLetter, seats: [{ categoryLetter,
 * statusCode, slotIndex, seatNumber, available }] }.
 */
function parseRow(rowBlock) {
    var fields = rowBlock.split(':');
    if (fields.length < 3) {
        throw fatalError('malformed row "' + rowBlock + '"');
    }
    var seats = [];
    for (var i = 2; i < fields.length; i++) {
        var match = fields[i].match(/^([A-Za-z])(\d)(\d+)\+(\d+)$/);
        if (!match) {
            throw fatalError('malformed seat "' + fields[i] + '" in row "' + fields[1] + '"');
        }
        seats.push({
            categoryLetter: match[1],
            statusCode: match[2],
            slotIndex: match[3],
            seatNumber: match[4],
            available: AVAILABLE_STATUS_CODES.indexOf(match[2]) !== -1
        });
    }
    return {
        rowcode: fields[0],
        rowname: fields[1],
        categoryLetter: seats[0].categoryLetter,
        seats: seats
    };
}

function processRow(row, seenSeatKeys, newSeatKeys, stats, categoryNames) {
    var categoryName = categoryNames[row.categoryLetter] || row.categoryLetter;

    row.seats.forEach(function (seat) {
        if (!seat.available) {
            return;
        }

        stats.totalAvailable++;
        stats.perRow[row.rowname] = (stats.perRow[row.rowname] || 0) + 1;
        stats.perCategory[categoryName] = (stats.perCategory[categoryName] || 0) + 1;

        var seatNumber = parseInt(seat.seatNumber, 10);
        if (!isSeatWanted(row.rowname, seatNumber)) {
            return;
        }

        var seatKey = row.rowname + seatNumber;
        seenSeatKeys.add(seatKey);
        stats.wantedSeats.push(seatKey);
        if (!alertedSeatKeys.has(seatKey)) {
            alertedSeatKeys.add(seatKey);
            newSeatKeys.push(seatKey);
        }
    });
}

function writeStatusFile(stats) {
    fs.writeFile(STATUS_FILE_PATH, JSON.stringify(stats, null, 2), function (err) {
        if (err) {
            console.error('status file write failed:', err.message);
        }
    });
}

function renderSeatLayoutRow(row) {
    var line = row.rowname.padEnd(2);

    row.seats.forEach(function (seat) {
        if (seat.seatNumber === '00') {
            line += ' .. ';
            return;
        }
        line += ' ' + (seat.available ? '[' + seat.seatNumber + ']' : ' ' + seat.seatNumber + ' ');
    });
    console.log(line);
}

/*
 * Category legend entry: "<name>:<categoryLetter>:<code>:<n>:<flag>:<n>".
 *
 *   MAJESTIC:A:0000000002:1:N:0
 *
 *   name            "MAJESTIC"    category name shown to users
 *   categoryLetter  "A"           letter used by the seats of this category
 *   code            "0000000002"  unknown (zero-padded number, differs per category)
 *   n               "1"           unknown (1, 2, 3, ... across the legend)
 *   flag            "N"           unknown
 *   n               "0"           unknown
 *
 * Only name and categoryLetter are used.
 */
function parseCategoryNames(legend) {
    var names = {};
    legend.split('|').forEach(function (entry) {
        var fields = entry.split(':');
        if (fields.length < 2) {
            throw fatalError('malformed legend entry "' + entry + '"');
        }
        names[fields[1]] = fields[0];
    });
    return names;
}

/*
 * decrypted = "<category legend>||<row>|<row>|..." where "|" separates entries
 * and "||" separates the legend from the rows. Example (shortened):
 *
 *   MAJESTIC:A:0000000002:1:N:0|GRAND:B:0000000003:2:N:0||1:R:A101+01:A000+00:A206+05|2:M:B101+01:B406+06
 *
 * The part before "||" is the category legend, see parseCategoryNames; each
 * part after it is a row, see parseRow.
 */
function parseSeatLayout(decrypted) {
    var sections = decrypted.split('||');
    if (sections.length < 2) {
        throw fatalError('decrypted data has no "||" separator between legend and rows');
    }
    return {
        legend: sections[0],
        categoryNames: parseCategoryNames(sections[0]),
        rows: sections[1].split('|').filter(function (rowBlock) {
            return rowBlock !== '';
        }).map(parseRow)
    };
}

function printSeatLayout(layout) {
    console.log('=== Category legend ===');
    console.log(layout.legend);
    console.log('');
    console.log('=== Seat layout ([xx] = available, xx = booked, .. = no seat) ===');

    var currentCategory = null;
    layout.rows.forEach(function (row) {
        if (row.categoryLetter !== currentCategory) {
            if (currentCategory !== null) {
                console.log('');
            }
            console.log('--- ' + (layout.categoryNames[row.categoryLetter] || row.categoryLetter) + ' ---');
            currentCategory = row.categoryLetter;
        }
        renderSeatLayoutRow(row);
    });
}

// Returns the encrypted strData; any failure here is transient.
async function fetchEncryptedLayout() {
    var text = await common.fetchText(BMS_URL, {
        method: 'POST',
        headers: headers,
        body: dataString
    });

    var data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        throw new Error('response is not JSON');
    }
    if (!data || !data.BookMyShow) {
        throw new Error('response has no BookMyShow key');
    }
    if (data.BookMyShow.blnSuccess === 'false') {
        throw new Error('BookMyShow reported failure: ' + (data.BookMyShow.strException || JSON.stringify(data)));
    }
    if (!data.BookMyShow.strData) {
        throw new Error('response has no strData');
    }
    return data.BookMyShow.strData;
}

function processSeatLayout(layout) {
    var stats = {
        timestamp: new Date().toISOString(),
        totalAvailable: 0,
        perRow: {},
        perCategory: {},
        wantedAvailable: 0,
        wantedSeats: []
    };

    var seenSeatKeys = new Set();
    var newSeatKeys = [];
    layout.rows.forEach(function (row) {
        processRow(row, seenSeatKeys, newSeatKeys, stats, layout.categoryNames);
    });
    if (newSeatKeys.length > 0) {
        alertSeatsAvailable(newSeatKeys);
    }
    stats.wantedAvailable = stats.wantedSeats.length;
    writeStatusFile(stats);

    // Drop keys for seats that are no longer available so they can re-alert later.
    alertedSeatKeys.forEach(function (seatKey) {
        if (!seenSeatKeys.has(seatKey)) {
            alertedSeatKeys.delete(seatKey);
        }
    });
}

common.runPoller('bms watcher', args, args.printLayout, async function () {
    var layout = parseSeatLayout(decrypt(await fetchEncryptedLayout()));
    if (args.printLayout) {
        printSeatLayout(layout);
    } else {
        processSeatLayout(layout);
    }
});
