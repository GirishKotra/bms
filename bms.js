var request = require('request');
var CryptoJS = require('crypto-js');
var fs = require('fs');
var path = require('path');

var STATUS_FILE_PATH = path.join(__dirname, 'status.json');

var AES_KEY = CryptoJS.enc.Utf8.parse('kYp3s6v9y$B&E)H+MbQeThWmZq4t7w!z');
var AES_IV = CryptoJS.lib.WordArray.create(0, 128);

// Seat status codes that mean a seat is available to book.
var AVAILABLE_STATUS_CODES = ['1', '4', '7', '8'];

// Seat-number ranges (inclusive) to alert on, per row.
var CUSTOM_ROW_RANGES = {
    B: [12, 30],
    J: [10, 22]
};
var DEFAULT_RANGE_ROWS = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L', 'M'];
var DEFAULT_RANGE = [12, 25];

var DEFAULTS = {
    venueCode: 'ALUC',
    param1: '2903',
    printLayout: false,
    pollIntervalMs: 60000,
    ntfyTopic: process.env.NTFY_TOPIC,
    notifyRepeat: 3,
    notifyRepeatIntervalMs: 10000
};

function parseArgs(argv) {
    var args = Object.assign({}, DEFAULTS);
    argv.forEach(function (arg) {
        if (arg === '--print-layout') {
            args.printLayout = true;
            return;
        }
        var match = arg.match(/^--([^=]+)=(.*)$/);
        if (!match) {
            return;
        }
        var key = match[1], value = match[2];
        switch (key) {
            case 'venue-code': args.venueCode = value; break;
            case 'param1': args.param1 = value; break;
            case 'poll-interval': args.pollIntervalMs = parseInt(value, 10); break;
            case 'ntfy-topic': args.ntfyTopic = value; break;
            case 'notify-repeat': args.notifyRepeat = parseInt(value, 10); break;
            case 'notify-repeat-interval': args.notifyRepeatIntervalMs = parseInt(value, 10); break;
        }
    });
    return args;
}

var args = parseArgs(process.argv.slice(2));

if (!args.ntfyTopic && !args.printLayout) {
    console.error('Set NTFY_TOPIC env var or pass --ntfy-topic=<topic>');
    process.exit(1);
}

var CLIENT_IP = process.env.BMS_CLIENT_IP;

var NTFY_URL = 'https://ntfy.sh/' + args.ntfyTopic;

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
    + '&lngTransactionIdentifier=0&strParam1=' + args.param1
    + '&strParam2=WEB&strParam3=&strParam4=&strParam5=Y&strParam6=&strParam7=&strParam8=&strParam9=&strParam10=&strFormat=json';

var options = {
    url: 'https://services-in.bookmyshow.com/doTrans.aspx',
    method: 'POST',
    headers: headers,
    body: dataString
};

function decrypt(base64CipherText) {
    var ciphertext = CryptoJS.enc.Base64.parse(base64CipherText);
    return CryptoJS.AES.decrypt({
        ciphertext: ciphertext
    }, AES_KEY, {
        mode: CryptoJS.mode.CBC,
        iv: AES_IV
    }).toString(CryptoJS.enc.Utf8);
}

function getWantedRange(rowname) {
    if (CUSTOM_ROW_RANGES[rowname]) {
        return CUSTOM_ROW_RANGES[rowname];
    }
    if (DEFAULT_RANGE_ROWS.indexOf(rowname) !== -1) {
        return DEFAULT_RANGE;
    }
    return null;
}

function isSeatWanted(rowname, seatNumber) {
    var range = getWantedRange(rowname);
    return range !== null && seatNumber >= range[0] && seatNumber <= range[1];
}

function sendNtfyAlert(message) {
    request({ url: NTFY_URL, method: 'POST', body: message }, function (err) {
        if (err) {
            console.error('ntfy alert failed:', err.message);
        }
    });
}

function alertSeatAvailable(rowname, seatNumber) {
    var message = 'Seat ' + rowname + seatNumber + ' available!';
    console.log('ALERT:', message);
    for (var burst = 0; burst < args.notifyRepeat; burst++) {
        setTimeout(function () {
            sendNtfyAlert(message);
        }, burst * args.notifyRepeatIntervalMs);
    }
}

// Each row block looks like "rowcode:rowname:seat1:seat2:...".
// Each seat looks like "<catLetter><statusDigit><slotIndex>+<seatNumber>", e.g. "D101+35".
// slotIndex is the physical column/slot position (includes aisle gaps); seatNumber
// (after "+") is the actual seat number shown in the BookMyShow UI.
function processRow(rowBlock, seenSeatKeys, stats, categoryNames) {
    var fields = rowBlock.split(':');
    var row = {
        rowcode: fields[0],
        rowname: fields[1],
        catagories: [],
        rawcatorder: [],
        catorder: [],
        seats: []
    };
    var categoryLetter = fields[2].charAt(0);
    var categoryName = categoryNames[categoryLetter] || categoryLetter;

    for (var i = 2; i < fields.length; i++) {
        var seat = fields[i];
        var parts = seat.split('+');
        var statusCode = parts[0].substr(1, 1);
        var isAvailable = AVAILABLE_STATUS_CODES.indexOf(statusCode) !== -1;
        if (!isAvailable) {
            continue;
        }

        stats.totalAvailable++;
        stats.perRow[row.rowname] = (stats.perRow[row.rowname] || 0) + 1;
        stats.perCategory[categoryName] = (stats.perCategory[categoryName] || 0) + 1;

        var seatNumber = parseInt(parts[1], 10);
        if (!isSeatWanted(row.rowname, seatNumber)) {
            continue;
        }

        var seatKey = row.rowname + seatNumber;
        seenSeatKeys.add(seatKey);
        stats.wantedSeats.push(seatKey);
        if (!alertedSeatKeys.has(seatKey)) {
            alertedSeatKeys.add(seatKey);
            alertSeatAvailable(row.rowname, seatNumber);
        }
    }
}

function writeStatusFile(stats) {
    fs.writeFile(STATUS_FILE_PATH, JSON.stringify(stats, null, 2), function (err) {
        if (err) {
            console.error('status file write failed:', err.message);
        }
    });
}

function renderSeatLayoutRow(rowBlock) {
    var fields = rowBlock.split(':');
    var rowname = fields[1];
    var line = rowname.padEnd(2);

    for (var i = 2; i < fields.length; i++) {
        var seat = fields[i];
        var parts = seat.split('+');
        var statusCode = parts[0].substr(1, 1);
        var seatNumber = parts[1];
        if (seatNumber === '00') {
            line += ' .. ';
            continue;
        }
        var isAvailable = AVAILABLE_STATUS_CODES.indexOf(statusCode) !== -1;
        line += ' ' + (isAvailable ? '[' + seatNumber + ']' : ' ' + seatNumber + ' ');
    }
    console.log(line);
}

// Legend entries look like "NAME:catLetter:code:num:flag:num".
function parseCategoryNames(legend) {
    var names = {};
    legend.split('|').forEach(function (entry) {
        var fields = entry.split(':');
        names[fields[1]] = fields[0];
    });
    return names;
}

// A row's category is the seat token's catLetter prefix (e.g. "B201+40" -> "B"),
// not the rowname -- multiple consecutive rows can share one category.
function rowCategoryLetter(rowBlock) {
    var firstSeat = rowBlock.split(':')[2];
    return firstSeat.charAt(0);
}

function printSeatLayout(decrypted, rowBlocks) {
    var legend = decrypted.split('||')[0];
    var categoryNames = parseCategoryNames(legend);

    console.log('=== Category legend ===');
    console.log(legend);
    console.log('');
    console.log('=== Seat layout ([xx] = available, xx = booked, .. = no seat) ===');

    var currentCategory = null;
    for (var n = 0; n < rowBlocks.length; n++) {
        if (rowBlocks[n] === '') {
            continue;
        }
        var categoryLetter = rowCategoryLetter(rowBlocks[n]);
        if (categoryLetter !== currentCategory) {
            if (currentCategory !== null) {
                console.log('');
            }
            console.log('--- ' + (categoryNames[categoryLetter] || categoryLetter) + ' ---');
            currentCategory = categoryLetter;
        }
        renderSeatLayoutRow(rowBlocks[n]);
    }
}

function handleSeatLayoutResponse(error, response, body) {
    if (error || response.statusCode != 200) {
        console.error('Request failed:', error || response.statusCode);
        return;
    }

    var data = JSON.parse(body);
    if (data.BookMyShow.blnSuccess === 'false') {
        console.log(Date.now(), data);
        return;
    }

    var decrypted = decrypt(data.BookMyShow.strData);

    // decrypted = "<category legend>||<row1>|<row2>|..."
    var rowBlocks = decrypted.split('||')[1].split('|');

    if (args.printLayout) {
        printSeatLayout(decrypted, rowBlocks);
        return;
    }

    var categoryNames = parseCategoryNames(decrypted.split('||')[0]);
    var stats = {
        timestamp: new Date().toISOString(),
        totalAvailable: 0,
        perRow: {},
        perCategory: {},
        wantedAvailable: 0,
        wantedSeats: []
    };

    var seenSeatKeys = new Set();
    for (var n = 0; n < rowBlocks.length; n++) {
        if (rowBlocks[n] !== '') {
            processRow(rowBlocks[n], seenSeatKeys, stats, categoryNames);
        }
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

request(options, handleSeatLayoutResponse);
if (!args.printLayout) {
    setInterval(function () {
        request(options, handleSeatLayoutResponse);
    }, args.pollIntervalMs);
}
