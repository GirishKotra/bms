var common = require('./common');
var bmsapi = require('./bmsapi');

var fail = common.fail;
var fatalError = common.fatalError;

var BYVENUE_URL = 'https://in.bookmyshow.com/api/v3/mobile/showtimes/byvenue';

// ntfy messages are limited to about 4KB.
var MAX_MESSAGE_BYTES = 3900;

// Startup checks: requests per theatre (one per open date) and per movie (one per edition and date) at most.
var MAX_VENUE_DATES = 10;
var MAX_MOVIE_REQUESTS = 30;

var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

var isRealDate = common.isRealDate;

// Command-line options / config keys that hold a single value.
var OPTIONS = [
    { key: 'venueCodes', flag: 'venue-codes', type: 'list', itemHint: 'venue codes' },
    { key: 'city', flag: 'city', type: 'string' },
    { key: 'movie', flag: 'movie', type: 'string' },
    { key: 'format', flag: 'format', type: 'string' },
    {
        key: 'dates', flag: 'dates', type: 'list', itemHint: 'real calendar dates as YYYYMMDD',
        validate: isRealDate
    },
    { key: 'ntfyTopic', flag: 'ntfy-topic', type: 'string' },
    { key: 'pollIntervalMs', flag: 'poll-interval-ms', type: 'int', min: 1 },
    { key: 'alertRepeat', flag: 'alert-repeat', type: 'int', min: 1 },
    { key: 'alertRepeatIntervalMs', flag: 'alert-repeat-interval-ms', type: 'int', min: 0 }
];

var HELP = [
    'formats - watch BookMyShow theatres and send an ntfy alert once a movie is listed in a screen format.',
    '',
    'Usage: node formats.js --venue-codes=<codes> --city=<city> --movie=<title> --format=<format> --dates=<dates> [options]',
    '',
    'Options:',
    '  --venue-codes=<codes>            Comma-separated BookMyShow venue codes (required, e.g. ALUC,PVHY)',
    '  --city=<city>                    City of the theatres (required, e.g. hyderabad); used by the startup checks',
    '  --movie=<title>                  Movie title to look for (required, e.g. "Avengers: Doomsday")',
    '                                   Matches shows whose title contains this, ignoring case and punctuation',
    '  --format=<format>                Screen format to look for (required, e.g. "DOLBY CINEMA")',
    '                                   Matches shows whose screen attribute (e.g. "LASER 4K ATMOS")',
    '                                   contains this, ignoring case and repeated spaces',
    '  --dates=<dates>                  Comma-separated show dates, YYYYMMDD (required, e.g. 20261218,20261219)',
    '  --poll-interval-ms=<ms>          Time between polls, >= 1 (default 300000; BookMyShow caches',
    '                                   this data for 5 minutes, so polling faster gains nothing)',
    '  --ntfy-topic=<topic>             ntfy topic to alert (required)',
    '  --alert-repeat=<n>               Times the alert is sent, >= 1 (default 3)',
    '  --alert-repeat-interval-ms=<ms>  Gap between repeated alerts, >= 0 (default 10000)',
    '  --config=<path>                  JSON config file (see below)',
    '  -h, --help                       Show this help',
    '',
    'The script sends one alert listing every matching show, then exits. Shows already listed',
    'when it starts count. A date BookMyShow has not opened for booking has no shows.',
    '',
    'Alongside polling (starting at once, never delaying it) it runs three best-effort checks that only print:',
    'that each theatre lists any show in the format, that the movie has shows in the format at any theatre',
    'in the city, and that the format is among those BookMyShow plans for the movie.',
    '',
    'Environment variables:',
    '  NTFY_TOPIC                       ntfy topic (same as --ntfy-topic)',
    '',
    'Config file keys (JSON object, all optional, unknown keys are rejected):',
    '  venueCodes (array of strings), city, movie, format, dates (array of "YYYYMMDD" strings), ntfyTopic,',
    '  pollIntervalMs, alertRepeat, alertRepeatIntervalMs',
    '',
    'Precedence (later wins): built-in defaults < config file < env vars < command-line flags.',
    '',
    'Examples:',
    '  NTFY_TOPIC=my-secret-topic node formats.js --venue-codes=ALUC --city=hyderabad \\',
    '      --movie="Avengers: Doomsday" --format="DOLBY CINEMA" --dates=20261218,20261219',
    '  node formats.js --config=formats.json'
].join('\n');

function loadSettings(argv) {
    var settings = common.loadSettings(argv, {
        help: HELP,
        options: OPTIONS,
        defaults: {
            pollIntervalMs: 300000,
            alertRepeat: 3,
            alertRepeatIntervalMs: 10000
        }
    });

    var missing = [];
    if (!settings.venueCodes) { missing.push('--venue-codes'); }
    if (!settings.city) { missing.push('--city'); }
    if (!settings.movie) { missing.push('--movie'); }
    if (!settings.format) { missing.push('--format'); }
    if (!settings.dates) { missing.push('--dates'); }
    if (missing.length > 0) {
        fail(missing.join(', ') + ' required (as flags or in the config file), see --help');
    }
    if (!settings.ntfyTopic) {
        fail('Set NTFY_TOPIC env var, pass --ntfy-topic=<topic>, or set ntfyTopic in the config file (see --help)');
    }
    return settings;
}

var args = loadSettings(process.argv.slice(2));

// Venues that already got the "no show data" warning.
var warnedVenues = new Set();

var normalize = bmsapi.normalize;
var normalizeWords = bmsapi.normalizeWords;

// Movies match ignoring case, punctuation and spacing; formats ignoring case and spacing only.
var wantedMovie = normalizeWords(args.movie);
var wantedFormat = normalize(args.format);
if (wantedMovie === '') {
    fail('--movie must contain at least one letter or digit, got ' + JSON.stringify(args.movie));
}

function titleMatches(title) {
    return normalizeWords(title).indexOf(wantedMovie) !== -1;
}

// Returns { venueName, skipped, shows: [{ title, attributes, screen, sessionId, time }] }
// with the shows of that date matching the movie and format. Transient
// errors (network, HTTP status, not JSON) throw plain errors; a JSON body
// whose top-level structure is wrong means the API changed and throws a fatal
// one. Malformed individual entries are skipped and counted in skipped.
async function fetchMatchingShows(venueCode, date) {
    var text = await common.fetchText(BYVENUE_URL + '?dateCode=' + date + '&venueCode=' + encodeURIComponent(venueCode), {});

    var data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        throw new Error('response is not JSON');
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.ShowDetails)) {
        throw fatalError('response for ' + venueCode + ' ' + date + ' has no ShowDetails array');
    }
    var result = { venueName: venueCode, skipped: 0, shows: [] };

    // Unknown venues and venues with nothing open both come back empty.
    if (data.ShowDetails.length === 0) {
        if (!warnedVenues.has(venueCode)) {
            warnedVenues.add(venueCode);
            console.error('Warning: no show data for venue ' + venueCode + ' (unknown venue code, or nothing open for booking)');
        }
        return result;
    }

    var day = data.ShowDetails[0];
    if (!day || typeof day.Date !== 'string' || !Array.isArray(day.Event)) {
        throw fatalError('response for ' + venueCode + ' ' + date + ' has no ShowDetails[0].Date / Event');
    }
    if (day.Venues && typeof day.Venues.VenueName === 'string' && day.Venues.VenueName !== '') {
        result.venueName = day.Venues.VenueName;
    }

    // A date that is not open for booking returns the nearest open date instead.
    if (day.Date !== date) {
        return result;
    }

    day.Event.forEach(function (event) {
        if (!event || typeof event.EventTitle !== 'string' || !Array.isArray(event.ChildEvents)) {
            result.skipped++;
            return;
        }
        event.ChildEvents.forEach(function (child) {
            if (!child || !Array.isArray(child.ShowTimes)) {
                result.skipped++;
                return;
            }
            child.ShowTimes.forEach(function (show) {
                if (!show || typeof show.Attributes !== 'string') {
                    result.skipped++;
                    return;
                }
                if (titleMatches(event.EventTitle) && normalize(show.Attributes).indexOf(wantedFormat) !== -1) {
                    if (typeof show.ShowDateTime !== 'string') {
                        result.skipped++;
                        return;
                    }
                    result.shows.push({
                        title: event.EventTitle,
                        attributes: show.Attributes,
                        screen: show.ScreenName,
                        sessionId: show.SessionId,
                        time: show.ShowDateTime.slice(8, 10) + ':' + show.ShowDateTime.slice(10, 12)
                    });
                }
            });
        });
    });
    return result;
}

// "20261218" -> "Fri 18 Dec"
function formatDate(date) {
    var utc = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))));
    return DAY_NAMES[utc.getUTCDay()] + ' ' + Number(date.slice(6, 8)) + ' ' + MONTH_NAMES[utc.getUTCMonth()];
}

// "19:30 (SCREEN 1, session 7045)"; title and screen format are added when
// they differ from what was asked for.
function describeShow(show) {
    var details = [];
    if (normalizeWords(show.title) !== wantedMovie) {
        details.push(show.title);
    }
    if (normalize(show.attributes) !== wantedFormat) {
        details.push(show.attributes);
    }
    if (show.screen) {
        details.push(show.screen);
    }
    details.push('session ' + show.sessionId);
    return show.time + ' (' + details.join(', ') + ')';
}

// matches: [{ venueName, date, shows }]. Shows are listed grouped by venue and
// date; if the message would exceed MAX_MESSAGE_BYTES the last ones are dropped
// and replaced by "...and N more".
function buildMessage(matches) {
    var entries = [];
    matches.forEach(function (match) {
        match.shows.forEach(function (show) {
            entries.push({ venueName: match.venueName, date: match.date, text: describeShow(show) });
        });
    });

    function render(count) {
        var lines = [args.movie + ' in ' + args.format + ' is now listed!'];
        var lastGroup = null;
        var lastVenue = null;
        entries.slice(0, count).forEach(function (entry) {
            var group = entry.venueName + '|' + entry.date;
            if (group !== lastGroup) {
                if (entry.venueName !== lastVenue) {
                    lines.push('', entry.venueName);
                    lastVenue = entry.venueName;
                }
                lines.push(formatDate(entry.date) + ': ' + entry.text);
                lastGroup = group;
            } else {
                lines[lines.length - 1] += ', ' + entry.text;
            }
        });
        if (count < entries.length) {
            lines.push('', '...and ' + (entries.length - count) + ' more');
        }
        return lines.join('\n');
    }

    var count = entries.length;
    while (count > 1 && Buffer.byteLength(render(count)) > MAX_MESSAGE_BYTES) {
        count--;
    }
    return render(count);
}

// Requests every (venue, date) pair in turn. Returns true (stop polling) once
// an alert was delivered. A failure for one pair does not hide matches found
// for the others: matches are alerted first, then a fatal error (if any) is
// thrown. A transient error is rethrown only if nothing matched. If no alert
// send succeeded, throws a transient error so the next poll retries.
async function poll() {
    var matches = [];
    var transientError = null;
    var fatalErr = null;
    var skipped = 0;
    for (var v = 0; v < args.venueCodes.length; v++) {
        for (var d = 0; d < args.dates.length; d++) {
            try {
                var result = await fetchMatchingShows(args.venueCodes[v], args.dates[d]);
                skipped += result.skipped;
                if (result.shows.length > 0) {
                    matches.push({ venueName: result.venueName, date: args.dates[d], shows: result.shows });
                }
            } catch (err) {
                if (err.fatal) {
                    fatalErr = fatalErr || err;
                } else {
                    transientError = transientError || err;
                }
            }
        }
    }
    if (skipped > 0) {
        console.error('Warning: skipped ' + skipped + ' malformed entries in the BookMyShow response (API format may have changed)');
    }
    if (matches.length > 0) {
        var delivered = await common.alertBurst(args, buildMessage(matches));
        if (fatalErr) {
            throw fatalErr;
        }
        if (!delivered) {
            throw new Error('alert not delivered to ntfy, will retry');
        }
        return true;
    }
    if (fatalErr || transientError) {
        throw fatalErr || transientError;
    }
    return false;
}

// ---- Startup checks: best effort, they only print ----

function hasFormat(text) {
    return normalize(text).indexOf(wantedFormat) !== -1;
}

// The theatre's shows over its open dates (up to MAX_VENUE_DATES requests), stopping at the first show in the format.
async function checkTheatre(venueCode) {
    var first = await bmsapi.fetchVenueDay(venueCode, args.dates[0]);
    var name = first.name || venueCode;
    if (first.date === null) {
        console.log('Warning: ' + venueCode + ' has no show data (unknown venue code, or nothing open for booking)');
        return;
    }
    var seenDates = [];
    var formats = [];
    var hit = null;
    var requests = 1;
    var queue = first.openDates;

    function look(day) {
        if (day.date === null || seenDates.indexOf(day.date) !== -1) {
            return;
        }
        seenDates.push(day.date);
        day.shows.forEach(function (show) {
            if (show.attributes !== '' && formats.indexOf(show.attributes) === -1) {
                formats.push(show.attributes);
            }
            if (!hit && hasFormat(show.attributes)) {
                hit = { date: day.date, show: show };
            }
        });
    }

    look(first);
    for (var i = 0; i < queue.length && requests < MAX_VENUE_DATES && !hit; i++) {
        if (seenDates.indexOf(queue[i]) === -1) {
            look(await bmsapi.fetchVenueDay(venueCode, queue[i]));
            requests++;
        }
    }
    if (hit) {
        console.log('OK: ' + name + ' (' + venueCode + ') lists ' + args.format + ' shows, e.g. ' + formatDate(hit.date) + ' ' +
            hit.show.time + ' ' + hit.show.title + ' (' + hit.show.attributes + ')');
    } else {
        console.log('Warning: ' + name + ' (' + venueCode + ') lists no shows in ' + args.format + ' on its open dates (' +
            seenDates.length + ' of ' + queue.length + ' checked); formats it does list: ' + (formats.join(', ') || 'none'));
    }
}

async function checkTheatres() {
    for (var v = 0; v < args.venueCodes.length; v++) {
        await checkTheatre(args.venueCodes[v]);
    }
}

// Looked up once for the movie checks: { city, movies: [{ code, title }] }. A failure is kept and shared.
var movieLookup = null;

function lookupMovies() {
    movieLookup = movieLookup || bmsapi.resolveCity(args.city).then(function (city) {
        return bmsapi.findMovies(city, args.movie).then(function (movies) {
            return {
                city: city,
                movies: movies.filter(function (movie) { return titleMatches(movie.title); })
            };
        });
    });
    return movieLookup;
}

// The movie's shows on each date, for its default edition and every other edition listed in the city
// (the format chips of the first answer). state counts requests across movies.
async function fetchEditionDays(city, movie, state) {
    var days = [];
    var codes = [movie.code];
    for (var e = 0; e < codes.length; e++) {
        for (var d = 0; d < args.dates.length; d++) {
            if (state.requests >= MAX_MOVIE_REQUESTS) {
                state.truncated = true;
                return days;
            }
            state.requests++;
            var day = await bmsapi.fetchMovieDay(city, codes[e], args.dates[d]);
            days.push({ date: args.dates[d], shows: day.shows });
            if (e === 0 && d === 0) {
                day.editions.forEach(function (edition) {
                    if (codes.indexOf(edition.code) === -1) {
                        codes.push(edition.code);
                    }
                });
            }
        }
    }
    return days;
}

async function checkFilmInCity() {
    var found = await lookupMovies();
    if (found.movies.length === 0) {
        console.log('Warning: no movie with "' + args.movie + '" in its title found for ' + found.city.name + ' in BookMyShow search');
        return;
    }
    var theatres = {};
    var state = { requests: 0, truncated: false };
    for (var m = 0; m < found.movies.length; m++) {
        var days = await fetchEditionDays(found.city, found.movies[m], state);
        days.forEach(function (day) {
            day.shows.forEach(function (show) {
                if (show.date === day.date && hasFormat(show.attributes)) {
                    var theatre = theatres[show.venueCode] = theatres[show.venueCode] || { name: show.venueName, dates: [] };
                    if (theatre.dates.indexOf(day.date) === -1) {
                        theatre.dates.push(day.date);
                    }
                }
            });
        });
    }
    var codes = Object.keys(theatres);
    var scope = 'on ' + args.dates.join(', ') + (state.truncated ? ' (stopped after ' + MAX_MOVIE_REQUESTS + ' requests)' : '');
    if (codes.length === 0) {
        console.log('Warning: no shows in ' + args.format + ' for ' + args.movie + ' at any theatre in ' + found.city.name + ' ' + scope);
        return;
    }
    console.log('OK: ' + args.movie + ' has shows in ' + args.format + ' in ' + found.city.name + ' ' + scope + ' at:');
    codes.forEach(function (code) {
        console.log('  ' + code + ' ' + theatres[code].name + ' (' + theatres[code].dates.map(formatDate).join(', ') + ')');
    });
}

async function checkPlannedFormats() {
    var found = await lookupMovies();
    if (found.movies.length === 0) {
        throw new Error('movie not found in BookMyShow search');
    }
    for (var m = 0; m < found.movies.length; m++) {
        var movie = found.movies[m];
        var planned = await bmsapi.fetchPlannedFormats(found.city, movie.code);
        var matching = planned.filter(hasFormat);
        if (matching.length > 0) {
            console.log('OK: ' + movie.title + ' (' + movie.code + ') is planned in ' + matching.join(', ') + ' (all: ' + planned.join(', ') + ')');
        } else {
            console.log('Warning: none of the formats planned for ' + movie.title + ' (' + movie.code + ') contains ' + args.format +
                ' (planned: ' + planned.join(', ') + ')');
        }
    }
}

async function runCheck(name, check) {
    try {
        await check();
    } catch (err) {
        console.log('Warning: could not check ' + name + ': ' + err.message);
    }
}

// Prints what BookMyShow says about the settings, so typos show up while waiting for an alert. Never throws.
async function runStartupChecks() {
    console.log('Startup checks (warnings only, run alongside polling):');
    await runCheck('theatres', checkTheatres);
    await runCheck('movie in city', checkFilmInCity);
    await runCheck('planned formats', checkPlannedFormats);
    console.log('Startup checks done.');
}

// The checks run alongside polling and only print. Their requests may still be in flight (up to the request
// timeout each) when polling ends, so the process exits explicitly instead of waiting for them.
runStartupChecks();
common.runPoller('bms format watcher', args, false, poll, function () {
    process.exit();
});
