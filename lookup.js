var common = require('./common');
var bmsapi = require('./bmsapi');

var fail = common.fail;

var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Editions are looked up for this many matching movies at most (one request each).
var MAX_EDITION_MOVIES = 5;

var HELP = [
    'lookup - find BookMyShow theatre codes, movie editions and session ids.',
    '',
    'Usage:',
    '  node lookup.js theatre --city=<city> <text>',
    '  node lookup.js movie --city=<city> <text>',
    '  node lookup.js shows --city=<city> --theatre=<text or venue code> --movie=<text> --date=<YYYYMMDD> [--time=<HH:MM>]',
    '',
    'Run "node lookup.js <command> --help" for details. -h, --help shows this text.'
].join('\n');

var COMMANDS = {
    theatre: {
        flags: ['city'],
        usage: 'node lookup.js theatre --city=<city> <text>',
        help: [
            'List the theatres in a city whose name or address contains every word of <text> (ignoring case),',
            'with their venue codes.',
            '',
            '  --city=<city>   City name, e.g. hyderabad, bengaluru (bangalore works too)',
            '',
            'Example:',
            '  node lookup.js theatre --city=hyderabad "allu kokapet"'
        ]
    },
    movie: {
        flags: ['city'],
        usage: 'node lookup.js movie --city=<city> <text>',
        help: [
            'List the movies whose title contains every word of <text> (ignoring case): event code, event group,',
            'and the editions (format and language, each with its own event code) BookMyShow lists in the city.',
            'Editions come from the nearest date open for booking; at most ' + MAX_EDITION_MOVIES + ' movies get their editions listed.',
            '',
            '  --city=<city>   City name',
            '',
            'Example:',
            '  node lookup.js movie --city=hyderabad "avengers doomsday"'
        ]
    },
    shows: {
        flags: ['city', 'theatre', 'movie', 'date', 'time'],
        usage: 'node lookup.js shows --city=<city> --theatre=<text or venue code> --movie=<text> --date=<YYYYMMDD> [--time=<HH:MM>]',
        help: [
            'List the shows of a movie at one theatre on one date: time, screen, screen format, edition, language',
            'and session id, with the bms.js command that watches the show\'s seats.',
            '',
            '  --city=<city>        City name',
            '  --theatre=<text>     Theatre name/address words, or a venue code of a theatre in --city;',
            '                       must match exactly one theatre',
            '  --movie=<text>       Movie title words',
            '  --date=<YYYYMMDD>    Show date; a date not open for booking is reported with the open dates',
            '  --time=<HH:MM>       Only the show starting at this time (24-hour clock)',
            '',
            'Example:',
            '  node lookup.js shows --city=hyderabad --theatre="allu kokapet" --movie="avengers doomsday" --date=20261218'
        ]
    }
};

function commandHelp(name) {
    var command = COMMANDS[name];
    return ['Usage: ' + command.usage, ''].concat(command.help).join('\n');
}

// Returns { city, text, theatre, movie, date, time } from the arguments after the command name. Bare
// words are joined into the text of the theatre and movie commands.
function parseArgs(name, argv) {
    var command = COMMANDS[name];
    if (argv.indexOf('-h') !== -1 || argv.indexOf('--help') !== -1) {
        console.log(commandHelp(name));
        process.exit(0);
    }
    var options = {};
    var words = [];
    argv.forEach(function (arg) {
        var match = arg.match(/^--([^=]+)=(.*)$/);
        if (match && command.flags.indexOf(match[1]) !== -1) {
            if (match[2].trim() === '') {
                fail('--' + match[1] + ' must not be empty');
            }
            options[match[1]] = match[2].trim();
        } else if (arg.slice(0, 1) === '-' || name === 'shows') {
            fail('Unknown option: ' + arg + ' (see "node lookup.js ' + name + ' --help")');
        } else {
            words.push(arg);
        }
    });
    options.text = words.join(' ').trim();

    var missing = command.flags.filter(function (flag) { return flag !== 'time' && options[flag] === undefined; });
    if (name !== 'shows' && options.text === '') {
        missing.push('<text>');
    }
    if (missing.length > 0) {
        fail(missing.join(', ') + ' required, see "node lookup.js ' + name + ' --help"');
    }
    ['text', 'theatre', 'movie'].forEach(function (key) {
        if (options[key] !== undefined && (key !== 'text' || name !== 'shows') && bmsapi.words(options[key]).length === 0) {
            fail((key === 'text' ? '<text>' : '--' + key) + ' must contain at least one letter or digit, got ' + JSON.stringify(options[key]));
        }
    });
    if (options.date !== undefined && !common.isRealDate(options.date)) {
        fail('--date must be a real calendar date as YYYYMMDD, got ' + JSON.stringify(options.date));
    }
    if (options.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(options.time)) {
        fail('--time must be HH:MM on a 24-hour clock, got ' + JSON.stringify(options.time));
    }
    return options;
}

// Prints rows (arrays of strings) with every column but the last padded to line up.
function printTable(rows, indent) {
    var widths = [];
    rows.forEach(function (row) {
        row.forEach(function (cell, index) {
            widths[index] = Math.max(widths[index] || 0, String(cell).length);
        });
    });
    rows.forEach(function (row) {
        var line = row.map(function (cell, index) {
            return index === row.length - 1 ? cell : String(cell) + ' '.repeat(widths[index] - String(cell).length);
        }).join('  ');
        console.log(indent + line);
    });
}

// "20261218" -> "Fri 18 Dec 2026"
function formatDate(date) {
    var utc = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))));
    return DAY_NAMES[utc.getUTCDay()] + ' ' + Number(date.slice(6, 8)) + ' ' + MONTH_NAMES[utc.getUTCMonth()] + ' ' + date.slice(0, 4);
}

function today() {
    var now = new Date();
    return String(now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate());
}

function noteFallback(err) {
    console.error('Note: could not read the city\'s cinemas page (' + err.message + '); using search instead, which may miss theatres.');
}

async function theatreCommand(options) {
    var city = await bmsapi.resolveCity(options.city);
    var theatres = await bmsapi.findTheatres(city, options.text, noteFallback);
    if (theatres.length === 0) {
        fail('No theatre in ' + city.name + ' matches "' + options.text + '"');
    }
    console.log(theatres.length + ' theatre(s) in ' + city.name + ' matching "' + options.text + '":');
    printTable(theatres.map(function (theatre) { return [theatre.code, theatre.name, theatre.address]; }), '');
}

async function movieCommand(options) {
    var city = await bmsapi.resolveCity(options.city);
    var movies = await bmsapi.findMovies(city, options.text);
    if (movies.length === 0) {
        fail('No movie matches "' + options.text + '"');
    }
    console.log(movies.length + ' movie(s) matching "' + options.text + '":');
    for (var i = 0; i < movies.length; i++) {
        var movie = movies[i];
        console.log('');
        console.log(movie.code + '  ' + movie.title + (movie.group ? '  (event group ' + movie.group + ')' : ''));
        if (i >= MAX_EDITION_MOVIES) {
            continue;
        }
        var seen = {};
        var editions = (await bmsapi.fetchMovieDay(city, movie.code, today())).editions.filter(function (edition) {
            var key = edition.code + '|' + edition.language;
            return !seen[key] && (seen[key] = true);
        });
        if (editions.length === 0) {
            console.log('  No editions listed in ' + city.name);
        } else {
            console.log('  Editions in ' + city.name + ':');
            printTable(editions.map(function (edition) { return [edition.code, edition.format, edition.language]; }), '    ');
        }
    }
    if (movies.length > MAX_EDITION_MOVIES) {
        console.log('');
        console.log('Editions are listed for the first ' + MAX_EDITION_MOVIES + ' movies only; narrow the text to see the others.');
    }
}

async function resolveTheatre(city, text) {
    var theatres = await bmsapi.findTheatres(city, text, noteFallback);
    if (theatres.length === 0) {
        fail('No theatre in ' + city.name + ' matches "' + text + '"');
    }
    if (theatres.length > 1) {
        console.error(theatres.length + ' theatres in ' + city.name + ' match "' + text + '":');
        printTable(theatres.map(function (theatre) { return [theatre.code, theatre.name, theatre.address]; }), '');
        fail('Be more specific, or pass one of these venue codes as --theatre.');
    }
    return theatres[0];
}

function uniqueTitles(shows) {
    return shows.map(function (show) { return show.title; }).filter(function (title, index, all) {
        return all.indexOf(title) === index;
    });
}

async function showsCommand(options) {
    var city = await bmsapi.resolveCity(options.city);
    var theatre = await resolveTheatre(city, options.theatre);
    var label = theatre.name + ' (' + theatre.code + ')';
    var day = await bmsapi.fetchVenueDay(theatre.code, options.date);
    if (day.date !== options.date) {
        fail(options.date + ' is not open for booking at ' + label + '. Open dates: ' +
            (day.openDates.length > 0 ? day.openDates.join(', ') : '(none)'));
    }
    var shows = day.shows.filter(function (show) { return bmsapi.containsWords(show.title, options.movie); });
    if (shows.length === 0) {
        fail('No show matching "' + options.movie + '" at ' + label + ' on ' + options.date +
            '. Movies listed that day: ' + uniqueTitles(day.shows).join(', '));
    }
    if (options.time !== undefined) {
        var times = shows.map(function (show) { return show.time; });
        shows = shows.filter(function (show) { return show.time === options.time; });
        if (shows.length === 0) {
            fail('No show at ' + options.time + ' for "' + options.movie + '" at ' + label + ' on ' + options.date +
                '. Show times: ' + times.sort().join(', '));
        }
    }
    shows.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });

    console.log(label + ', ' + formatDate(options.date) + ': ' + shows.length + ' show(s) matching "' + options.movie + '"');
    var rows = [['TIME', 'SCREEN', 'FORMAT', 'EDITION', 'LANGUAGE', 'SESSION', 'WATCH SEATS']];
    shows.forEach(function (show) {
        rows.push([show.time, show.screen, show.attributes, show.edition, show.language, show.sessionId,
            'node bms.js --venue-code=' + theatre.code + ' --session-id=' + show.sessionId]);
    });
    printTable(rows, '');
}

async function main() {
    var argv = process.argv.slice(2);
    var name = argv[0];
    if (name === '-h' || name === '--help') {
        console.log(HELP);
        return;
    }
    if (!name) {
        fail(HELP);
    }
    if (!COMMANDS.hasOwnProperty(name)) {
        fail('Unknown command: ' + name + ' (see --help)');
    }
    var options = parseArgs(name, argv.slice(1));
    await { theatre: theatreCommand, movie: movieCommand, shows: showsCommand }[name](options);
}

main().catch(function (err) {
    fail('Error: ' + err.message);
});
